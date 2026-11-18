import { REDACT_PATHS } from '@arc/shared';
import { buildApp } from './app.js';
import { syncProviderCatalogue } from './catalogue/providers.js';
import { cookieSecure, loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { createDependencies } from './dependencies.js';
import { HttpProviderProbe } from './providers/probe.js';
import { CredentialService } from './vault/credentials.js';
import { loadKeyRing } from './vault/vault.js';

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
const deps = createDependencies(config, db);
const keyRing = loadKeyRing(config.ARC_VAULT_KEY_FILE);

const app = buildApp({
  checks: deps.checks,
  readinessTimeoutMs: config.READINESS_TIMEOUT_MS,
  trustProxy: config.TRUST_PROXY,
  logger: { level: config.LOG_LEVEL, redact: { paths: [...REDACT_PATHS] } },
  admin: {
    db,
    credentials: new CredentialService(keyRing),
    probe: new HttpProviderProbe(),
    cookieSecure: cookieSecure(config),
    sessionTtlMs: config.SESSION_TTL_HOURS * 3_600_000,
    probeTimeoutMs: config.PROBE_TIMEOUT_MS,
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
