import type { FastifyError, FastifyInstance } from 'fastify';
import type { z } from 'zod';

const TYPE_BY_STATUS: Record<number, string> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  409: 'conflict_error',
  413: 'invalid_request_error',
  415: 'invalid_request_error',
  429: 'rate_limit_error',
  503: 'service_unavailable_error',
};

/** An error that is safe to show to the caller as-is. */
export class ArcError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new ArcError(404, 'not_found', `${what} not found`);
export const forbidden = (message = 'You do not have permission to do this') =>
  new ArcError(403, 'forbidden', message);
export const unauthenticated = () => new ArcError(401, 'unauthenticated', 'Sign in to continue');

/** Parse input with a Zod schema, turning failures into a 400 with field-level details. */
export function parseInput<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ArcError(
      400,
      'invalid_request',
      'Request validation failed',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

/** Consistent error envelope: { error: { type, code, message, details? } }. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | ArcError, req, reply) => {
    if (err instanceof ArcError) {
      return reply.code(err.statusCode).send({
        error: {
          type: TYPE_BY_STATUS[err.statusCode] ?? 'api_error',
          code: err.code,
          message: err.message,
          ...(err.details === undefined ? {} : { details: err.details }),
        },
      });
    }
    const status = err.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      return reply.code(status).send({
        error: {
          type: TYPE_BY_STATUS[status] ?? 'invalid_request_error',
          code: err.code ?? 'bad_request',
          message: err.message,
        },
      });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({
      error: { type: 'api_error', code: 'internal_error', message: 'Internal server error' },
    });
  });

  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({
      error: { type: 'not_found_error', code: 'route_not_found', message: 'Route not found' },
    }),
  );
}
