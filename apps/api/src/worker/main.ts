/**
 * ARC background worker. Runs everything that must stay OFF the synchronous inference path:
 * route scoring from observed outcomes, periodic key health checks with model discovery, and
 * telemetry pruning. It is a separate process: the API never waits for it, and only reads the
 * results it publishes (with lock/statement timeouts).
 */
import { REDACT_PATHS, baseEnvSchema, parseEnv } from '@arc/shared';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import { z } from 'zod';
import { migrate } from '../db/migrate.js';
import { createPool } from '../db/pool.js';
import { startMetricsServer } from '../observability/metrics.js';
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
    METRICS_HOST: z.string().default('0.0.0.0'),
    METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(9465),
    HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1000).default(15_000),
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
const workerId = `${hostname()}-${randomUUID().slice(0, 8)}`;
const startedAt = new Date();
const lastResult: Record<string, { ok: boolean; at: string; ms: number }> = {};

const registry = new Registry();
const jobDuration = new Histogram({
  name: 'arc_worker_job_duration_ms',
  help: 'Worker job duration',
  labelNames: ['job'] as const,
  buckets: [5, 25, 100, 500, 2000, 10_000, 60_000, 120_000],
  registers: [registry],
});
const jobFailures = new Counter({
  name: 'arc_worker_job_failures_total',
  help: 'Worker job failures',
  labelNames: ['job'] as const,
  registers: [registry],
});
const jobLastSuccess = new Gauge({
  name: 'arc_worker_job_last_success_timestamp_seconds',
  help: 'Unix time of the last successful run of each job',
  labelNames: ['job'] as const,
  registers: [registry],
});

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
      jobLastSuccess.set({ job: name }, Date.now() / 1000);
      lastResult[name] = { ok: true, at: new Date().toISOString(), ms: Date.now() - started };
    } catch (err) {
      log.warn({ job: name, err: (err as Error).message, ms: Date.now() - started }, 'job failed');
      jobFailures.inc({ job: name });
      lastResult[name] = { ok: false, at: new Date().toISOString(), ms: Date.now() - started };
    } finally {
      jobDuration.observe({ job: name }, Date.now() - started);
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
every('heartbeat', config.HEARTBEAT_INTERVAL_MS, 10_000, () =>
  db.query(
    `INSERT INTO worker_heartbeats (worker_id, hostname, started_at, last_seen, jobs)
     VALUES ($1, $2, $3, now(), $4)
     ON CONFLICT (worker_id) DO UPDATE SET last_seen = now(), jobs = EXCLUDED.jobs`,
    [workerId, hostname(), startedAt, lastResult],
  ),
);
if (config.METRICS_PORT)
  await startMetricsServer(registry, config.METRICS_HOST, config.METRICS_PORT);
log.info('worker started');

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'shutting down');
  timers.forEach(clearInterval);
  await db
    .query('DELETE FROM worker_heartbeats WHERE worker_id = $1', [workerId])
    .catch(() => undefined);
  await db.end().catch(() => undefined);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
