import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { registerErrorHandler } from './errors.js';
import { checkReadiness, type DependencyCheck } from './readiness.js';
import { REQUEST_ID_HEADER, genRequestId } from './request-id.js';
import { accountRoutes } from './routes/accounts.js';
import { apiKeyRoutes } from './routes/api-keys.js';
import { authRoutes } from './routes/auth.js';
import { catalogueRoutes } from './routes/catalogue.js';
import type { AdminDeps } from './routes/deps.js';
import { type InferenceDeps, inferenceRoutes } from './routes/inference.js';
import { tenantRoutes } from './routes/tenant.js';

export interface BuildAppOptions {
  checks: readonly DependencyCheck[];
  readinessTimeoutMs: number;
  /** Control-plane admin API. Omitted in tests that only cover health endpoints. */
  admin?: AdminDeps;
  /** OpenAI-compatible inference API under /v1. */
  inference?: InferenceDeps;
  logger?: FastifyServerOptions['logger'];
  trustProxy?: boolean;
}

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? false,
    genReqId: genRequestId,
    requestIdHeader: false,
    trustProxy: opts.trustProxy ?? false,
    bodyLimit: 1024 * 1024,
    // Keep connections alive for clients that reuse them (latency-first).
    keepAliveTimeout: 72_000,
    return503OnClosing: true,
  });

  registerErrorHandler(app);

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

  const admin = opts.admin;
  if (admin) {
    app.register(
      async (scope) => {
        await scope.register(cookie);
        scope.addHook('onSend', async (_req, reply) => {
          reply.header('cache-control', 'no-store');
        });
        await scope.register((s) => authRoutes(s, admin));
        await scope.register((s) => catalogueRoutes(s, admin));
        await scope.register((s) => accountRoutes(s, admin));
        await scope.register((s) => tenantRoutes(s, admin));
        await scope.register((s) => apiKeyRoutes(s, admin));
      },
      { prefix: '/admin/v1' },
    );
  }

  const inference = opts.inference;
  if (inference) {
    app.register((scope) => inferenceRoutes(scope, inference), { prefix: '/v1' });
  }

  return app;
}
