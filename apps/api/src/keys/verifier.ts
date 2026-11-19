import type { Db } from '../db/pool.js';
import { TtlCache } from '../util/ttl-cache.js';
import { parseArcKey, secretMatches } from './arc-keys.js';

export type Scope = 'inference' | 'models:read';

export interface ApiKeyPrincipal {
  apiKeyId: string;
  keyId: string;
  tenantId: string;
  tenantKind: 'platform' | 'personal' | 'organization';
  applicationId: string;
  applicationSlug: string;
  firstParty: boolean;
  scopes: readonly Scope[];
}

interface CachedKey {
  principal: ApiKeyPrincipal;
  secretHash: Buffer;
  expiresAt: number | null;
}

/**
 * Verifies ARC API keys. Valid keys are cached briefly so the hot path does not hit the
 * database on every request; the secret hash is still compared each time.
 * Revocation is immediate on this instance (invalidate) and within CACHE_TTL elsewhere.
 */
export class ApiKeyVerifier {
  static readonly CACHE_TTL_MS = 30_000;
  private readonly cache = new TtlCache<string, CachedKey>(ApiKeyVerifier.CACHE_TTL_MS);
  private readonly lastTouched = new TtlCache<string, true>(60_000);

  constructor(private readonly db: Db) {}

  async verify(token: string): Promise<ApiKeyPrincipal | null> {
    const parsed = parseArcKey(token);
    if (!parsed) return null;

    let entry = this.cache.get(parsed.keyId);
    if (!entry) {
      entry = (await this.load(parsed.keyId)) ?? undefined;
      if (!entry) return null;
      this.cache.set(parsed.keyId, entry);
    }
    if (!secretMatches(parsed.secret, entry.secretHash)) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.cache.delete(parsed.keyId);
      return null;
    }
    this.touch(entry.principal.apiKeyId);
    return entry.principal;
  }

  invalidate(keyId: string): void {
    this.cache.delete(keyId);
  }

  /** Record last use at most once a minute per key, off the request path. */
  private touch(apiKeyId: string): void {
    if (this.lastTouched.get(apiKeyId)) return;
    this.lastTouched.set(apiKeyId, true);
    this.db
      .query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [apiKeyId])
      .catch(() => undefined);
  }

  private async load(keyId: string): Promise<CachedKey | null> {
    const { rows } = await this.db.query<{
      id: string;
      secret_hash: Buffer;
      scopes: Scope[];
      expires_at: Date | null;
      tenant_id: string;
      kind: ApiKeyPrincipal['tenantKind'];
      application_id: string;
      slug: string;
      first_party: boolean;
    }>(
      `SELECT k.id, k.secret_hash, k.scopes, k.expires_at, k.tenant_id, t.kind,
              k.application_id, a.slug, a.first_party
         FROM api_keys k
         JOIN applications a ON a.id = k.application_id AND a.tenant_id = k.tenant_id
         JOIN tenants t ON t.id = k.tenant_id
        WHERE k.key_id = $1 AND k.revoked_at IS NULL
          AND (k.expires_at IS NULL OR k.expires_at > now())
          AND a.disabled_at IS NULL AND t.suspended_at IS NULL`,
      [keyId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      secretHash: r.secret_hash,
      expiresAt: r.expires_at ? r.expires_at.getTime() : null,
      principal: {
        apiKeyId: r.id,
        keyId,
        tenantId: r.tenant_id,
        tenantKind: r.kind,
        applicationId: r.application_id,
        applicationSlug: r.slug,
        firstParty: r.first_party,
        scopes: r.scopes,
      },
    };
  }
}
