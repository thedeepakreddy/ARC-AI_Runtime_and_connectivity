/**
 * ARC background worker.
 *
 * Hosts everything that must stay OFF the synchronous inference path:
 * model discovery, health polling, quota sync, performance aggregation
 * and adaptive ranking. Jobs are added in later phases; for now the process
 * starts, validates config and shuts down cleanly.
 */
import { baseEnvSchema, parseEnv } from '@arc/shared';

const config = parseEnv(baseEnvSchema);

function log(level: string, msg: string): void {
  if (config.LOG_LEVEL === 'silent') return;
  process.stdout.write(`${JSON.stringify({ time: Date.now(), level, service: 'worker', msg })}\n`);
}

log('info', 'worker started (no jobs registered yet)');
const keepAlive = setInterval(() => undefined, 60_000);

function shutdown(signal: string): void {
  log('info', `shutting down on ${signal}`);
  clearInterval(keepAlive);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
