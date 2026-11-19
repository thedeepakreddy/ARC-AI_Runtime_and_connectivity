import { REDACT_PATHS } from '@arc/shared';
import { Redis } from 'ioredis';
import { buildApp } from './app.js';
import { type CoordinationBus, LocalBus, RedisBus } from './coordination/bus.js';
import { RedisRateLimiter } from './coordination/rate-limit.js';
import { ArcMetrics, startMetricsServer } from './observability/metrics.js';
import { startHealthMonitor } from './observability/monitor.js';
import { syncProviderCatalogue } from './catalogue/providers.js';
import { cookieSecure, loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { createDependencies } from './dependencies.js';
import { CandidateStore } from './inference/candidates.js';
import { Cooldowns } from './inference/cooldowns.js';
import { ObservationRecorder } from './inference/observations.js';
import { LiteLLMGateway } from './inference/gateway.js';
import { ApiKeyVerifier } from './keys/verifier.js';
import { HttpProviderProbe } from './providers/probe.js';
import { CredentialService } from './vault/credentials.js';
import { loadKeyRing } from './vault/vault.js';

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
const deps = createDependencies(config, db);
const keyRing = loadKeyRing(config.ARC_VAULT_KEY_FILE);
const credentials = new CredentialService(keyRing);
const verifier = new ApiKeyVerifier(db);
const candidates = new CandidateStore(db);
const cooldowns = new Cooldowns();
const observations = new ObservationRecorder(db);
observations.start();
const metrics = new ArcMetrics({ defaultMetrics: true });

// Cross-instance coordination (Redis). Nothing on the request path waits for these.
const bus: CoordinationBus =
  config.COORDINATION === 'redis' ? new RedisBus(config.REDIS_URL) : new LocalBus();
const limiterRedis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  connectTimeout: 2000,
});
limiterRedis.on('error', () => undefined);
const rateLimiter = new RedisRateLimiter(limiterRedis, config.RATE_LIMIT_PER_MINUTE);
bus.subscribe((event) => {
  if (event.type === 'api_key_revoked') verifier.invalidate(event.keyId);
  else if (event.type === 'routing_changed') candidates.invalidate();
  else if (event.type === 'cooldown') cooldowns.apply(event.accountId, event.reason, event.seconds);
});
cooldowns.onCooldown = (accountId, reason, seconds) =>
  bus.publish({ type: 'cooldown', accountId, reason, seconds });

const app = buildApp({
  checks: deps.checks,
  readinessTimeoutMs: config.READINESS_TIMEOUT_MS,
  trustProxy: config.TRUST_PROXY,
  logger: { level: config.LOG_LEVEL, redact: { paths: [...REDACT_PATHS] } },
  admin: {
    db,
    credentials,
    probe: new HttpProviderProbe(),
    cookieSecure: cookieSecure(config),
    sessionTtlMs: config.SESSION_TTL_HOURS * 3_600_000,
    probeTimeoutMs: config.PROBE_TIMEOUT_MS,
    onRoutingChange: () => {
      candidates.invalidate();
      bus.publish({ type: 'routing_changed' });
    },
    onApiKeyRevoked: (keyId) => {
      verifier.invalidate(keyId);
      bus.publish({ type: 'api_key_revoked', keyId });
    },
    routing: { candidates, cooldowns },
  },
  inference: {
    db,
    credentials,
    verifier,
    candidates,
    cooldowns,
    observations,
    gateway: new LiteLLMGateway(config.LITELLM_BASE_URL, config.LITELLM_MASTER_KEY),
    defaultDeadlineMs: config.DEFAULT_DEADLINE_MS,
    maxDeadlineMs: config.MAX_DEADLINE_MS,
    bodyLimitBytes: config.INFERENCE_BODY_LIMIT_MB * 1024 * 1024,
    requestsPerMinute: config.RATE_LIMIT_PER_MINUTE,
    maxAttempts: config.MAX_ATTEMPTS,
    metrics,
    rateLimiter,
    minAttemptMs: config.MIN_ATTEMPT_MS,
  },
});

if (config.MIGRATE_ON_START) {
  const applied = await migrate(db);
  if (applied.length) app.log.info({ applied }, 'migrations applied');
}
await syncProviderCatalogue(db);
const stopMonitor = startHealthMonitor({
  db,
  checks: deps.checks,
  metrics,
  timeoutMs: config.READINESS_TIMEOUT_MS,
  telemetryDropped: () => observations.dropped,
});
const metricsServer = config.METRICS_PORT
  ? await startMetricsServer(metrics.registry, config.METRICS_HOST, config.METRICS_PORT)
  : null;

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  // Let in-flight requests and streams finish, then force-close whatever remains.
  const force = setTimeout(() => app.server.closeAllConnections(), config.SHUTDOWN_GRACE_MS);
  force.unref();
  try {
    await app.close();
    await observations.stop();
    stopMonitor();
    metricsServer?.close();
    await bus.close();
    await limiterRedis.quit().catch(() => undefined);
    await deps.close();
    await db.end();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
