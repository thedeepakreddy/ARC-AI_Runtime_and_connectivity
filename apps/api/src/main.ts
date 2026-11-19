import { REDACT_PATHS } from '@arc/shared';
import { buildApp } from './app.js';
import { syncProviderCatalogue } from './catalogue/providers.js';
import { cookieSecure, loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { createDependencies } from './dependencies.js';
import { CandidateStore } from './inference/candidates.js';
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
    onRoutingChange: () => candidates.invalidate(),
    onApiKeyRevoked: (keyId) => verifier.invalidate(keyId),
  },
  inference: {
    db,
    credentials,
    verifier,
    candidates,
    gateway: new LiteLLMGateway(config.LITELLM_BASE_URL, config.LITELLM_MASTER_KEY),
    defaultDeadlineMs: config.DEFAULT_DEADLINE_MS,
    maxDeadlineMs: config.MAX_DEADLINE_MS,
    bodyLimitBytes: config.INFERENCE_BODY_LIMIT_MB * 1024 * 1024,
    requestsPerMinute: config.RATE_LIMIT_PER_MINUTE,
  },
});

if (config.MIGRATE_ON_START) {
  const applied = await migrate(db);
  if (applied.length) app.log.info({ applied }, 'migrations applied');
}
await syncProviderCatalogue(db);

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
