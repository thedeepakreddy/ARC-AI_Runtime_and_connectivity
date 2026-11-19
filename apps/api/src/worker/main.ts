/**
 * ARC background worker. Runs everything that must stay OFF the synchronous inference path:
 * route scoring from observed outcomes, periodic key health checks with model discovery, and
 * telemetry pruning. It is a separate process: the API never waits for it, and only reads the
 * results it publishes (with lock/statement timeouts).
 */
import { REDACT_PATHS, baseEnvSchema, parseEnv } from '@arc/shared';
import pino from 'pino';
import { z } from 'zod';
import { migrate } from '../db/migrate.js';
import { createPool } from '../db/pool.js';
import { HttpProviderProbe } from '../providers/probe.js';
import { CredentialService } from '../vault/credentials.js';
import { loadKeyRing } from '../vault/vault.js';
import { computeRouteScores, pruneObservations, revalidateStaleAccounts } from './jobs.js';

const config = parseEnv(
  baseEnvSchema.extend({
    DATABASE_URL: z.url(),
    ARC_VAULT_KEY_FILE: z.string().min(1),
    SCORE_INTERVAL_MS: z.coerce.number().int().min(1000).default(15_000),
    REVALIDATE_INTERVAL_MS: z.coerce.number().int().min(10_000).default(300_000),
    REVALIDATE_STALE_MINUTES: z.coerce.number().int().min(1).default(15),
    PROBE_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5000),
  }),
);

const log = pino({
  level: config.LOG_LEVEL,
  base: { service: 'worker' },
  redact: [...REDACT_PATHS],
});
const db = createPool(config.DATABASE_URL);
const credentials = new CredentialService(loadKeyRing(config.ARC_VAULT_KEY_FILE));
const probe = new HttpProviderProbe();

const timers: NodeJS.Timeout[] = [];
const running = new Set<string>();

/** Run a job on an interval; never overlap with itself; bound its runtime. */
function every(
  name: string,
  intervalMs: number,
  timeoutMs: number,
  job: () => Promise<unknown>,
): void {
  const tick = async () => {
    if (running.has(name)) return;
    running.add(name);
    const started = Date.now();
    try {
      const result = await Promise.race([
        job(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('job timed out')), timeoutMs).unref(),
        ),
      ]);
      log.debug({ job: name, result, ms: Date.now() - started }, 'job done');
    } catch (err) {
      log.warn({ job: name, err: (err as Error).message, ms: Date.now() - started }, 'job failed');
    } finally {
      running.delete(name);
    }
  };
  timers.push(setInterval(() => void tick(), intervalMs));
  void tick();
}

await migrate(db);
every('route-scores', config.SCORE_INTERVAL_MS, 30_000, () => computeRouteScores(db));
every('revalidate-keys', config.REVALIDATE_INTERVAL_MS, 120_000, () =>
  revalidateStaleAccounts(db, credentials, probe, {
    staleMinutes: config.REVALIDATE_STALE_MINUTES,
    invalidRecheckMinutes: 360,
    batchSize: 50,
    probeTimeoutMs: config.PROBE_TIMEOUT_MS,
  }),
);
every('prune-observations', 3_600_000, 60_000, () => pruneObservations(db));
log.info('worker started');

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'shutting down');
  timers.forEach(clearInterval);
  await db.end().catch(() => undefined);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
