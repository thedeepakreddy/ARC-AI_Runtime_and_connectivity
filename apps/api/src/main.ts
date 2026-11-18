import { REDACT_PATHS } from '@arc/shared';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDependencies } from './dependencies.js';

const config = loadConfig();
const deps = createDependencies(config);
const app = buildApp({
  checks: deps.checks,
  readinessTimeoutMs: config.READINESS_TIMEOUT_MS,
  logger: { level: config.LOG_LEVEL, redact: { paths: [...REDACT_PATHS] } },
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await deps.close();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
