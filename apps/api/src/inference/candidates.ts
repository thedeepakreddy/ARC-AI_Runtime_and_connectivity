import type { Db } from '../db/pool.js';
import { TtlCache } from '../util/ttl-cache.js';
import type { SealedSecret } from '../vault/vault.js';
import type { Capability } from './schemas.js';

export type Eligibility = 'VERIFIED_FREE' | 'RESTRICTED_FREE' | 'PAID' | 'UNKNOWN';
export type HealthStatus =
  'unknown' | 'healthy' | 'rate_limited' | 'invalid_credentials' | 'unreachable' | 'unsupported';

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
  jurisdiction: string;
  credentialId: string;
  sealed: SealedSecret;
}

/** Public model name used by applications: "<provider>/<model id>". */
export const publicModelName = (c: Pick<Candidate, 'providerId' | 'modelId'>) =>
  `${c.providerId}/${c.modelId}`;

export const ALIASES = ['auto', 'arc/fast', 'arc/balanced', 'arc/deep'] as const;
export type Alias = (typeof ALIASES)[number];
export const isAlias = (m: string): m is Alias => (ALIASES as readonly string[]).includes(m);

/**
 * Deterministic policy gate (blueprint §5). Owner-managed keys: strict free-only —
 * VERIFIED_FREE, or RESTRICTED_FREE within documented terms; PAID and UNKNOWN blocked.
 * Customer BYOK keys: the customer pays, so PAID is allowed; UNKNOWN never.
 */
export function passesPolicy(c: Candidate): boolean {
  if (c.eligibility === 'UNKNOWN') return false;
  if (c.scope === 'owner_private')
    return c.eligibility === 'VERIFIED_FREE' || c.eligibility === 'RESTRICTED_FREE';
  return true;
}

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

export interface Selection {
  chosen: Candidate;
  alternatives: number;
}

export type SelectionFailure =
  | { reason: 'unknown_model' }
  | { reason: 'no_eligible_key'; detail: string }
  | { reason: 'capability_missing'; missing: Capability[] };

/**
 * Phase 2 selection: policy gates, capability match, then a stable preference order
 * (healthier key, then free before paid). Phase 3 replaces the ordering with cached
 * performance rankings and adds bounded fallback.
 */
export function selectCandidate(
  all: readonly Candidate[],
  requested: string,
  need: ReadonlySet<Capability>,
): Selection | SelectionFailure {
  let pool: Candidate[];
  if (isAlias(requested)) {
    pool = [...all];
  } else {
    const slash = requested.indexOf('/');
    if (slash <= 0) return { reason: 'unknown_model' };
    const provider = requested.slice(0, slash);
    const model = requested.slice(slash + 1);
    pool = all.filter((c) => c.providerId === provider && c.modelId === model);
    if (pool.length === 0) return { reason: 'unknown_model' };
  }

  const allowed = pool.filter((c) => passesPolicy(c) && USABLE_HEALTH.has(c.health));
  if (allowed.length === 0) {
    return {
      reason: 'no_eligible_key',
      detail: 'no enabled key passes the free-only policy and health checks',
    };
  }
  const capable = allowed.filter((c) => [...need].every((n) => c.capabilities.has(n)));
  if (capable.length === 0) {
    const missing = [...need].filter((n) => !allowed.some((c) => c.capabilities.has(n)));
    return { reason: 'capability_missing', missing: missing.length ? missing : [...need] };
  }
  capable.sort(
    (a, b) =>
      HEALTH_RANK[a.health] - HEALTH_RANK[b.health] ||
      ELIGIBILITY_RANK[a.eligibility] - ELIGIBILITY_RANK[b.eligibility] ||
      a.accountId.localeCompare(b.accountId),
  );
  return { chosen: capable[0]!, alternatives: capable.length - 1 };
}

/**
 * Loads a tenant's routable (model, key) pairs. Cached per tenant for a few seconds so the
 * hot path normally does no database work; admin changes call invalidate().
 */
export class CandidateStore {
  static readonly TTL_MS = 5_000;
  private readonly cache = new TtlCache<string, Promise<Candidate[]>>(CandidateStore.TTL_MS, 5_000);

  constructor(private readonly db: Db) {}

  forTenant(tenantId: string): Promise<Candidate[]> {
    const hit = this.cache.get(tenantId);
    if (hit) return hit;
    const pending = this.load(tenantId);
    this.cache.set(tenantId, pending);
    pending.catch(() => this.cache.delete(tenantId));
    return pending;
  }

  invalidate(): void {
    this.cache.clear();
  }

  private async load(tenantId: string): Promise<Candidate[]> {
    const { rows } = await this.db.query<{
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
      jurisdiction: string;
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
    );
    return rows.map((r) => ({
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
      sealed: { kekVersion: r.kek_version, wrappedDek: r.wrapped_dek, ciphertext: r.ciphertext },
    }));
  }
}
