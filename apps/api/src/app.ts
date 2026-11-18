import { REDACT_PATHS } from '@arc/shared';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { checkReadiness, type DependencyCheck } from './readiness.js';
import { REQUEST_ID_HEADER, genRequestId } from './request-id.js';

export interface BuildAppOptions {
  checks: readonly DependencyCheck[];
  readinessTimeoutMs: number;
  logger?: FastifyServerOptions['logger'];
}

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? false,
    genReqId: genRequestId,
    requestIdHeader: false,
    // Keep connections alive for clients that reuse them (latency-first).
    keepAliveTimeout: 72_000,
    return503OnClosing: true,
  });

  if (opts.logger) {
    app.log.debug({ redact: REDACT_PATHS.length }, 'log redaction active');
  }

  app.addHook('onRequest', async (req, reply) => {
    reply.header(REQUEST_ID_HEADER, req.id);
  });

  /** Liveness: the process is up and serving. No dependency calls. */
  app.get('/healthz', async () => ({ status: 'ok' }));

  /** Readiness: dependencies reachable within a strict timeout. */
  app.get('/readyz', async (_req, reply) => {
    const report = await checkReadiness(opts.checks, opts.readinessTimeoutMs);
    return reply
      .code(report.ready ? 200 : 503)
      .send({ status: report.ready ? 'ready' : 'not_ready', ...report });
  });

  return app;
}
