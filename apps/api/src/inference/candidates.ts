import type { Db } from '../db/pool.js';
import { TtlCache } from '../util/ttl-cache.js';
import type { SealedSecret } from '../vault/vault.js';
import type { CooldownReason } from './cooldowns.js';
import type { Capability } from './schemas.js';
import { NEUTRAL_EXPECTED_MS } from './scoring.js';

export type Eligibility = 'VERIFIED_FREE' | 'RESTRICTED_FREE' | 'PAID' | 'UNKNOWN';
export type HealthStatus =
  'unknown' | 'healthy' | 'rate_limited' | 'invalid_credentials' | 'unreachable' | 'unsupported';
export type Jurisdiction = 'US' | 'EU' | 'UK' | 'CA' | 'CN' | 'SELF_HOSTED';

export interface Candidate {
  modelUuid: string;
  providerId: string;
  modelId: string;
  capabilities: ReadonlySet<Capability>;
  eligibility: Eligibility;
  accountId: string;
  scope: 'owner_private' | 'tenant_byok';
  health: HealthStatus;
  baseUrl: string | null;
  defaultBaseUrl: string | null;
  litellmProvider: string | null;
  jurisdiction: Jurisdiction;
  credentialId: string;
  sealed: SealedSecret;
  /** Precomputed by the worker; NEUTRAL_EXPECTED_MS when not yet measured. */
  expectedMs: number;
  samples: number;
}

export interface RoutingPolicy {
  /** null = all jurisdictions. */
  allowedJurisdictions: ReadonlySet<Jurisdiction> | null;
  allowPaidOwnerKeys: boolean;
}

export const DEFAULT_POLICY: RoutingPolicy = {
  allowedJurisdictions: null,
  allowPaidOwnerKeys: false,
};

/** Public model name used by applications: "<provider>/<model id>". */
export const publicModelName = (c: Pick<Candidate, 'providerId' | 'modelId'>) =>
  `${c.providerId}/${c.modelId}`;

export const ALIASES = ['auto', 'arc/fast', 'arc/balanced', 'arc/deep'] as const;
export type Alias = (typeof ALIASES)[number];
export const isAlias = (m: string): m is Alias => (ALIASES as readonly string[]).includes(m);

/**
 * Eligibility (blueprint §5). Owner-managed keys are strictly free-only — VERIFIED_FREE, or
 * RESTRICTED_FREE within documented terms — unless the platform owner explicitly allowed paid
 * models. Customer BYOK keys may use PAID (the customer pays). UNKNOWN is never eligible.
 */
export function passesPolicy(c: Candidate, policy: RoutingPolicy = DEFAULT_POLICY): boolean {
  if (c.eligibility === 'UNKNOWN') return false;
  if (c.scope === 'owner_private' && c.eligibility === 'PAID') return policy.allowPaidOwnerKeys;
  return true;
}

export type Verdict =
  | 'selected'
  | 'eligible'
  | 'rejected_model'
  | 'rejected_eligibility'
  | 'rejected_jurisdiction'
  | 'rejected_health'
  | 'rejected_cooldown'
  | 'rejected_capability';

export interface CandidateVerdict {
  model: string;
  accountId: string;
  eligibility: Eligibility;
  jurisdiction: Jurisdiction;
  health: HealthStatus;
  expectedMs: number;
  verdict: Verdict;
  detail?: string;
}

export interface Ranking {
  /** Fallback plan: best first, then the same model on other keys, then other compatible models. */
  plan: Candidate[];
  verdicts: CandidateVerdict[];
  rejected: Partial<Record<Verdict, number>>;
}

export type SelectionFailure =
  | { reason: 'unknown_model'; verdicts: CandidateVerdict[] }
  | {
      reason: 'no_eligible_key';
      detail: string;
      verdicts: CandidateVerdict[];
      rejected: Partial<Record<Verdict, number>>;
    }
  | { reason: 'capability_missing'; missing: Capability[]; verdicts: CandidateVerdict[] };

const USABLE_HEALTH: ReadonlySet<HealthStatus> = new Set(['healthy', 'unknown', 'rate_limited']);
const HEALTH_RANK: Record<HealthStatus, number> = {
  healthy: 0,
  unknown: 1,
  rate_limited: 2,
  unreachable: 3,
  unsupported: 3,
  invalid_credentials: 9,
};
const ELIGIBILITY_RANK: Record<Eligibility, number> = {
  VERIFIED_FREE: 0,
  RESTRICTED_FREE: 1,
  PAID: 2,
  UNKNOWN: 9,
};

export interface RankInput {
  requested: string;
  need: ReadonlySet<Capability>;
  policy: RoutingPolicy;
  cooldown: (accountId: string) => CooldownReason | null;
}

/**
 * Deterministic gates first (model, eligibility, jurisdiction, health, cooldown, capability),
 * then rank by: health bucket → eligibility (free before paid, an admin-defined bound) →
 * precomputed expected latency → stable id. No I/O and no model calls: microseconds.
 */
export function rankCandidates(
  all: readonly Candidate[],
  input: RankInput,
): Ranking | SelectionFailure {
  const { requested, need, policy } = input;
  const verdicts: CandidateVerdict[] = [];
  const rejected: Partial<Record<Verdict, number>> = {};
  const reject = (c: Candidate, verdict: Verdict, detail?: string) => {
    rejected[verdict] = (rejected[verdict] ?? 0) + 1;
    verdicts.push(toVerdict(c, verdict, detail));
  };

  let explicit: { provider: string; model: string } | null = null;
  if (!isAlias(requested)) {
    const slash = requested.indexOf('/');
    if (slash <= 0) return { reason: 'unknown_model', verdicts };
    explicit = { provider: requested.slice(0, slash), model: requested.slice(slash + 1) };
  }

  const passed: Candidate[] = [];
  let matchedModel = false;
  const capabilityRejected: Candidate[] = [];
  for (const c of all) {
    if (explicit && (c.providerId !== explicit.provider || c.modelId !== explicit.model)) continue;
    matchedModel = true;
    if (!passesPolicy(c, policy)) {
      reject(c, 'rejected_eligibility', c.eligibility);
      continue;
    }
    if (policy.allowedJurisdictions && !policy.allowedJurisdictions.has(c.jurisdiction)) {
      reject(c, 'rejected_jurisdiction', c.jurisdiction);
      continue;
    }
    if (!USABLE_HEALTH.has(c.health)) {
      reject(c, 'rejected_health', c.health);
      continue;
    }
    const cooling = input.cooldown(c.accountId);
    if (cooling) {
      reject(c, 'rejected_cooldown', cooling);
      continue;
    }
    const missing = [...need].filter((n) => !c.capabilities.has(n));
    if (missing.length) {
      capabilityRejected.push(c);
      reject(c, 'rejected_capability', missing.join(','));
      continue;
    }
    passed.push(c);
  }

  if (!matchedModel) return { reason: 'unknown_model', verdicts };
  if (passed.length === 0) {
    const onlyCapability =
      Object.keys(rejected).length === 1 && rejected.rejected_capability !== undefined;
    if (onlyCapability) {
      // Report what no candidate offers, not every gap of every model.
      const missing = [...need].filter(
        (n) => !capabilityRejected.some((c) => c.capabilities.has(n)),
      );
      return {
        reason: 'capability_missing',
        missing: missing.length ? missing : [...need],
        verdicts,
      };
    }
    return {
      reason: 'no_eligible_key',
      detail: 'no enabled key passes policy, jurisdiction, health and cooldown checks',
      verdicts,
      rejected,
    };
  }

  passed.sort(
    (a, b) =>
      HEALTH_RANK[a.health] - HEALTH_RANK[b.health] ||
      ELIGIBILITY_RANK[a.eligibility] - ELIGIBILITY_RANK[b.eligibility] ||
      a.expectedMs - b.expectedMs ||
      a.accountId.localeCompare(b.accountId),
  );

  // Fallback order: same model on other keys first, then other compatible models.
  const best = passed[0]!;
  const sameModel = passed.filter((c) => c.modelUuid === best.modelUuid);
  const otherModels = passed.filter((c) => c.modelUuid !== best.modelUuid);
  const plan = [...sameModel, ...otherModels];
  // The plan comes first (selected, then fallbacks), then everything that was rejected.
  const planVerdicts = plan.map((c, i) => toVerdict(c, i === 0 ? 'selected' : 'eligible'));
  return { plan, verdicts: [...planVerdicts, ...verdicts], rejected };
}

function toVerdict(c: Candidate, verdict: Verdict, detail?: string): CandidateVerdict {
  return {
    model: publicModelName(c),
    accountId: c.accountId,
    eligibility: c.eligibility,
    jurisdiction: c.jurisdiction,
    health: c.health,
    expectedMs: Math.round(c.expectedMs),
    verdict,
    ...(detail ? { detail } : {}),
  };
}

interface TenantRouting {
  candidates: Candidate[];
  tenantPolicy: RoutingPolicy;
  appPolicies: Map<string, RoutingPolicy>;
}

/**
 * Loads a tenant's routable (model, key) pairs, route scores and policies. Cached per tenant
 * for a few seconds so the hot path normally does no database work; admin changes call
 * invalidate(). Scores are read with tight lock/statement timeouts: if the worker is holding
 * the scores table, routing proceeds with neutral scores instead of waiting.
 */
export class CandidateStore {
  static readonly TTL_MS = 5_000;
  private readonly cache = new TtlCache<string, Promise<TenantRouting>>(
    CandidateStore.TTL_MS,
    5_000,
  );

  constructor(private readonly db: Db) {}

  async forTenant(tenantId: string): Promise<Candidate[]> {
    return (await this.routing(tenantId)).candidates;
  }

  async policyFor(tenantId: string, applicationId: string | null): Promise<RoutingPolicy> {
    const r = await this.routing(tenantId);
    return (applicationId && r.appPolicies.get(applicationId)) || r.tenantPolicy;
  }

  invalidate(): void {
    this.cache.clear();
  }

  private routing(tenantId: string): Promise<TenantRouting> {
    const hit = this.cache.get(tenantId);
    if (hit) return hit;
    const pending = this.load(tenantId);
    this.cache.set(tenantId, pending);
    pending.catch(() => this.cache.delete(tenantId));
    return pending;
  }

  private async load(tenantId: string): Promise<TenantRouting> {
    const [rows, scores, policies] = await Promise.all([
      this.db.query<{
        model_uuid: string;
        provider_id: string;
        model_id: string;
        capabilities: Capability[];
        eligibility: Eligibility;
        account_id: string;
        scope: Candidate['scope'];
        health_status: HealthStatus;
        base_url: string | null;
        default_base_url: string | null;
        litellm_provider: string | null;
        jurisdiction: Jurisdiction;
        credential_id: string;
        kek_version: number;
        wrapped_dek: Buffer;
        ciphertext: Buffer;
      }>(
        `SELECT m.id AS model_uuid, m.provider_id, m.model_id, m.capabilities, m.eligibility,
                a.id AS account_id, a.scope, a.health_status, a.base_url,
                p.default_base_url, p.litellm_provider, p.jurisdiction,
                c.id AS credential_id, c.kek_version, c.wrapped_dek, c.ciphertext
           FROM provider_accounts a
           JOIN account_models am ON am.account_id = a.id
           JOIN models m ON m.id = am.model_id AND m.provider_id = a.provider_id
           JOIN providers p ON p.id = a.provider_id
           JOIN credentials c ON c.id = a.credential_id AND c.tenant_id = a.tenant_id
          WHERE a.tenant_id = $1 AND a.enabled AND m.enabled`,
        [tenantId],
      ),
      this.loadScores(tenantId),
      this.db.query<{
        application_id: string | null;
        allowed_jurisdictions: Jurisdiction[] | null;
        allow_paid_owner_keys: boolean;
      }>(
        'SELECT application_id, allowed_jurisdictions, allow_paid_owner_keys FROM routing_policies WHERE tenant_id = $1',
        [tenantId],
      ),
    ]);

    const toPolicy = (p: {
      allowed_jurisdictions: Jurisdiction[] | null;
      allow_paid_owner_keys: boolean;
    }): RoutingPolicy => ({
      allowedJurisdictions: p.allowed_jurisdictions ? new Set(p.allowed_jurisdictions) : null,
      allowPaidOwnerKeys: p.allow_paid_owner_keys,
    });
    let tenantPolicy = DEFAULT_POLICY;
    const appPolicies = new Map<string, RoutingPolicy>();
    for (const p of policies.rows) {
      if (p.application_id) appPolicies.set(p.application_id, toPolicy(p));
      else tenantPolicy = toPolicy(p);
    }

    return {
      tenantPolicy,
      appPolicies,
      candidates: rows.rows.map((r) => {
        const score = scores.get(`${r.account_id}|${r.model_uuid}`);
        return {
          modelUuid: r.model_uuid,
          providerId: r.provider_id,
          modelId: r.model_id,
          capabilities: new Set(r.capabilities),
          eligibility: r.eligibility,
          accountId: r.account_id,
          scope: r.scope,
          health: r.health_status,
          baseUrl: r.base_url,
          defaultBaseUrl: r.default_base_url,
          litellmProvider: r.litellm_provider,
          jurisdiction: r.jurisdiction,
          credentialId: r.credential_id,
          sealed: {
            kekVersion: r.kek_version,
            wrappedDek: r.wrapped_dek,
            ciphertext: r.ciphertext,
          },
          expectedMs: score?.expectedMs ?? NEUTRAL_EXPECTED_MS,
          samples: score?.samples ?? 0,
        };
      }),
    };
  }

  /** Best-effort: never wait more than ~100 ms on the scores table. */
  private async loadScores(
    tenantId: string,
  ): Promise<Map<string, { expectedMs: number; samples: number }>> {
    const out = new Map<string, { expectedMs: number; samples: number }>();
    let client;
    try {
      client = await this.db.connect();
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '50ms'");
      await client.query("SET LOCAL statement_timeout = '100ms'");
      const { rows } = await client.query<{
        account_id: string;
        model_id: string;
        expected_ms: number;
        samples: number;
      }>(
        `SELECT s.account_id, s.model_id, s.expected_ms, s.samples
           FROM route_scores s JOIN provider_accounts a ON a.id = s.account_id
          WHERE a.tenant_id = $1`,
        [tenantId],
      );
      await client.query('COMMIT');
      for (const r of rows)
        out.set(`${r.account_id}|${r.model_id}`, { expectedMs: r.expected_ms, samples: r.samples });
    } catch {
      await client?.query('ROLLBACK').catch(() => undefined);
      // Neutral scores: routing still works, just without performance ordering.
    } finally {
      client?.release();
    }
    return out;
  }
}
