import type { Db } from '../db/pool.js';
import { scoreRoute } from '../inference/scoring.js';
import type { ProviderProbe } from '../providers/probe.js';
import { assertPublicHttpsUrl } from '../providers/url-guard.js';
import { validateAccount } from '../providers/validation.js';
import type { CredentialService } from '../vault/credentials.js';

const SCORES_LOCK = 7_041_990_101;
const REVALIDATE_LOCK = 7_041_990_102;

/** Run fn only if this worker holds the session advisory lock (one runner across instances). */
async function withJobLock<T>(db: Db, lockId: number, fn: () => Promise<T>): Promise<T | null> {
  const client = await db.connect();
  try {
    const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [
      lockId,
    ]);
    if (!rows[0]?.ok) return null;
    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [lockId]);
    }
  } finally {
    client.release();
  }
}

/**
 * Turn recent observations into route scores. Recent minutes weigh more (half-life decay);
 * routes with no traffic in the window drop back to neutral (their score row is removed).
 */
export async function computeRouteScores(
  db: Db,
  windowMinutes = 30,
  halfLifeMinutes = 10,
): Promise<number | null> {
  return withJobLock(db, SCORES_LOCK, async () => {
    const { rows } = await db.query<{
      account_id: string;
      model_id: string;
      requests: number;
      successes: number;
      ttfb_ms_sum: number;
      ttfb_samples: number;
    }>(
      `WITH w AS (
         SELECT *, power(0.5, extract(epoch FROM (now() - bucket)) / 60.0 / $2) AS weight
           FROM route_observations WHERE bucket > now() - make_interval(mins => $1)
       )
       SELECT account_id, model_id,
              sum(requests * weight)::float8 AS requests, sum(successes * weight)::float8 AS successes,
              sum(ttfb_ms_sum * weight)::float8 AS ttfb_ms_sum, sum(ttfb_samples * weight)::float8 AS ttfb_samples
         FROM w GROUP BY account_id, model_id`,
      [windowMinutes, halfLifeMinutes],
    );
    const cols: unknown[][] = [[], [], [], [], [], []];
    for (const r of rows) {
      const s = scoreRoute({
        requests: r.requests,
        successes: r.successes,
        ttfbMsSum: r.ttfb_ms_sum,
        ttfbSamples: r.ttfb_samples,
      });
      [
        r.account_id,
        r.model_id,
        Math.round(s.samples),
        s.successRate,
        s.avgTtfbMs,
        s.expectedMs,
      ].forEach((v, i) => cols[i]!.push(v));
    }
    await db.query('BEGIN');
    try {
      if (rows.length) {
        await db.query(
          `INSERT INTO route_scores (account_id, model_id, samples, success_rate, avg_ttfb_ms, expected_ms, computed_at)
           SELECT u.*, now() FROM unnest($1::uuid[], $2::uuid[], $3::int[], $4::float8[], $5::float8[], $6::float8[])
                  AS u(account_id, model_id, samples, success_rate, avg_ttfb_ms, expected_ms)
           JOIN provider_accounts a ON a.id = u.account_id JOIN models m ON m.id = u.model_id
           ON CONFLICT (account_id, model_id) DO UPDATE SET samples = EXCLUDED.samples,
             success_rate = EXCLUDED.success_rate, avg_ttfb_ms = EXCLUDED.avg_ttfb_ms,
             expected_ms = EXCLUDED.expected_ms, computed_at = EXCLUDED.computed_at`,
          cols,
        );
      }
      await db.query(
        'DELETE FROM route_scores WHERE computed_at < now() - make_interval(mins => $1)',
        [windowMinutes],
      );
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
    return rows.length;
  });
}

export interface RevalidateOptions {
  staleMinutes: number;
  /** Keys that failed authentication are re-checked far less often. */
  invalidRecheckMinutes: number;
  batchSize: number;
  probeTimeoutMs: number;
  urlGuard?: (url: string) => Promise<void>;
}

/** Re-check enabled keys whose health is stale. Probes run with timeouts, a few at a time. */
export async function revalidateStaleAccounts(
  db: Db,
  credentials: CredentialService,
  probe: ProviderProbe,
  opts: RevalidateOptions,
): Promise<number | null> {
  const guard = opts.urlGuard ?? assertPublicHttpsUrl;
  return withJobLock(db, REVALIDATE_LOCK, async () => {
    const { rows } = await db.query<{
      id: string;
      tenant_id: string;
      provider_id: string;
      adapter: 'litellm_native' | 'openai_compatible';
      credential_id: string;
      base_url: string | null;
      default_base_url: string | null;
      scope: string;
    }>(
      `SELECT a.id, a.tenant_id, a.provider_id, p.adapter, a.credential_id, a.base_url,
              p.default_base_url, a.scope
         FROM provider_accounts a JOIN providers p ON p.id = a.provider_id
        WHERE a.enabled AND a.health_status <> 'unsupported'
          AND (a.last_validated_at IS NULL
               OR (a.health_status <> 'invalid_credentials' AND a.last_validated_at < now() - make_interval(mins => $1))
               OR (a.health_status = 'invalid_credentials' AND a.last_validated_at < now() - make_interval(mins => $2)))
        ORDER BY a.last_validated_at NULLS FIRST
        LIMIT $3`,
      [opts.staleMinutes, opts.invalidRecheckMinutes, opts.batchSize],
    );
    let done = 0;
    const CONCURRENCY = 4;
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      await Promise.all(
        rows.slice(i, i + CONCURRENCY).map(async (r) => {
          try {
            // Customer-supplied URLs get the same SSRF check as in the admin API.
            if (r.scope === 'tenant_byok' && r.base_url) await guard(r.base_url);
            await validateAccount(
              db,
              credentials,
              probe,
              {
                id: r.id,
                tenantId: r.tenant_id,
                providerId: r.provider_id,
                adapter: r.adapter,
                credentialId: r.credential_id,
                baseUrl: r.base_url,
                defaultBaseUrl: r.default_base_url,
              },
              opts.probeTimeoutMs,
              null,
            );
          } catch {
            await db.query(
              `UPDATE provider_accounts SET health_status = 'unsupported', last_validated_at = now(),
                      last_validation_error = 'revalidation failed (base URL not allowed or probe error)'
                WHERE id = $1`,
              [r.id],
            );
          }
          done++;
        }),
      );
    }
    return done;
  });
}

export async function pruneObservations(db: Db, retentionHours = 24): Promise<number> {
  const r = await db.query(
    'DELETE FROM route_observations WHERE bucket < now() - make_interval(hours => $1)',
    [retentionHours],
  );
  return r.rowCount ?? 0;
}
