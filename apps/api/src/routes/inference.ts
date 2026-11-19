import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AttemptLimiter } from '../auth/throttle.js';
import type { Db } from '../db/pool.js';
import { ArcError, parseInput } from '../errors.js';
import {
  ALIASES,
  type Candidate,
  type CandidateStore,
  type Ranking,
  type SelectionFailure,
  isAlias,
  passesPolicy,
  publicModelName,
  rankCandidates,
} from '../inference/candidates.js';
import { type Cooldowns, parseRetryAfter } from '../inference/cooldowns.js';
import type { Endpoint, InferenceGateway } from '../inference/gateway.js';
import type { ObservationRecorder, Outcome } from '../inference/observations.js';
import {
  type Capability,
  chatPassthrough,
  chatRequestSchema,
  embeddingPassthrough,
  embeddingRequestSchema,
  requiredChatCapabilities,
} from '../inference/schemas.js';
import type { ApiKeyPrincipal, ApiKeyVerifier, Scope } from '../keys/verifier.js';
import type { CredentialService } from '../vault/credentials.js';

export interface InferenceDeps {
  db: Db;
  credentials: CredentialService;
  verifier: ApiKeyVerifier;
  candidates: CandidateStore;
  cooldowns: Cooldowns;
  observations: ObservationRecorder;
  gateway: InferenceGateway;
  /** Default and maximum request deadline (ms). Clients may lower it via x-arc-deadline-ms. */
  defaultDeadlineMs: number;
  maxDeadlineMs: number;
  bodyLimitBytes: number;
  requestsPerMinute: number;
  /** Max provider attempts per request (first try + fallbacks). */
  maxAttempts: number;
  /** Don't start a fallback attempt with less time than this left. */
  minAttemptMs: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: ApiKeyPrincipal;
    /** High-resolution arrival time (performance.now()), for ARC's own latency measurements. */
    arcStartedAt?: number;
  }
}

/** Milliseconds since the request arrived. Independent of logger settings. */
function elapsed(req: FastifyRequest): number {
  return performance.now() - (req.arcStartedAt ?? performance.now());
}

const DEADLINE_HEADER = 'x-arc-deadline-ms';
const EXPLAIN_HEADER = 'x-arc-explain';

type FailureKind = 'auth_failed' | 'rate_limited' | 'provider_error' | 'timeout';

interface Attempt {
  candidate: Candidate;
  failure: FailureKind;
  status?: number;
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1]! : null;
}

function requireScope(req: FastifyRequest, scope: Scope): ApiKeyPrincipal {
  const p = req.principal;
  if (!p) throw new ArcError(401, 'invalid_api_key', 'Invalid ARC API key');
  if (!p.scopes.includes(scope)) {
    throw new ArcError(403, 'insufficient_scope', `This key lacks the "${scope}" scope`);
  }
  return p;
}

function deadlineFor(req: FastifyRequest, deps: InferenceDeps): number {
  const raw = req.headers[DEADLINE_HEADER];
  if (raw === undefined) return deps.defaultDeadlineMs;
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isInteger(n) || n < 100) {
    throw new ArcError(400, 'invalid_deadline', `${DEADLINE_HEADER} must be an integer >= 100`);
  }
  return Math.min(n, deps.maxDeadlineMs);
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Compact, header-safe route explanation (top entries only). */
function explainHeader(
  verdicts: Ranking['verdicts'],
  rejected: Ranking['rejected'],
  attempts: Attempt[],
): string {
  return JSON.stringify({
    rejected,
    attempts: attempts.map((a) => ({
      account: a.candidate.accountId,
      model: publicModelName(a.candidate),
      failure: a.failure,
    })),
    candidates: verdicts
      .slice(0, 12)
      .map((v) => ({ m: v.model, a: v.accountId, v: v.verdict, ms: v.expectedMs, d: v.detail })),
  });
}

export async function inferenceRoutes(app: FastifyInstance, deps: InferenceDeps): Promise<void> {
  const { candidates, credentials, gateway, db, cooldowns, observations } = deps;
  const limiter = new AttemptLimiter(deps.requestsPerMinute, 60_000);

  app.addHook('onRequest', async (req) => {
    req.arcStartedAt = performance.now();
    const token = bearer(req);
    if (!token)
      throw new ArcError(401, 'missing_api_key', 'Provide an ARC API key as a Bearer token');
    const principal = await deps.verifier.verify(token);
    if (!principal) throw new ArcError(401, 'invalid_api_key', 'Invalid ARC API key');
    if (!limiter.hit(principal.apiKeyId)) {
      throw new ArcError(429, 'arc_rate_limited', 'Request rate limit for this key exceeded');
    }
    req.principal = principal;
  });

  /** Background health update after a provider tells us something about a key. */
  function markAccount(
    c: Candidate,
    status: 'invalid_credentials' | 'rate_limited',
    error: string,
  ): void {
    db.query(
      `UPDATE provider_accounts SET health_status = $2, last_validation_error = $3, updated_at = now()
        WHERE id = $1`,
      [c.accountId, status, error],
    )
      .then(() => candidates.invalidate())
      .catch(() => undefined);
  }

  /** Read and redact an upstream error body; classify whether fallback may help. */
  async function upstreamFailure(
    res: Response,
    apiKey: string,
    c: Candidate,
  ): Promise<{ error: ArcError; kind: FailureKind | 'client_error' }> {
    const raw = (await res.text().catch(() => '')).slice(0, 4000).split(apiKey).join('[REDACTED]');
    let detail = raw;
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: unknown } };
      if (typeof parsed.error?.message === 'string') detail = parsed.error.message;
    } catch {
      /* not JSON */
    }
    detail = detail.slice(0, 300);
    const s = res.status;
    if (s === 401 || s === 403) {
      markAccount(c, 'invalid_credentials', `provider responded ${s}`);
      cooldowns.authFailed(c.accountId);
      return {
        kind: 'auth_failed',
        error: new ArcError(
          502,
          'provider_auth_failed',
          'The provider rejected the key ARC used for this route',
        ),
      };
    }
    if (s === 429) {
      markAccount(c, 'rate_limited', 'provider responded 429');
      cooldowns.rateLimited(c.accountId, parseRetryAfter(res.headers.get('retry-after')));
      return {
        kind: 'rate_limited',
        error: new ArcError(
          429,
          'provider_rate_limited',
          'The provider is rate limiting this route; try again shortly',
        ),
      };
    }
    if (s === 408 || s === 504) {
      cooldowns.failed(c.accountId);
      return {
        kind: 'timeout',
        error: new ArcError(504, 'provider_timeout', 'The provider timed out'),
      };
    }
    if (s >= 400 && s < 500) {
      // The request itself was rejected: another key would reject it too. No fallback.
      return {
        kind: 'client_error',
        error: new ArcError(
          400,
          'provider_rejected_request',
          `The provider rejected the request: ${detail}`,
        ),
      };
    }
    cooldowns.failed(c.accountId);
    return {
      kind: 'provider_error',
      error: new ArcError(502, 'provider_error', `The provider returned an error (${s})`),
    };
  }

  function selectionError(failure: SelectionFailure, model: string): ArcError {
    if (failure.reason === 'unknown_model') {
      return new ArcError(404, 'model_not_found', `Model "${model}" is not available to this key`);
    }
    if (failure.reason === 'capability_missing') {
      return new ArcError(
        400,
        'capability_not_supported',
        `No eligible model supports: ${failure.missing.join(', ')}`,
        {
          missing: failure.missing,
        },
      );
    }
    return new ArcError(
      503,
      'no_eligible_route',
      `No eligible provider key for "${model}" right now`,
      {
        rejected: failure.rejected,
      },
    );
  }

  const OUTCOME: Record<FailureKind, Outcome> = {
    auth_failed: 'error',
    rate_limited: 'rate_limited',
    provider_error: 'error',
    timeout: 'timeout',
  };

  async function execute(
    req: FastifyRequest,
    reply: FastifyReply,
    endpoint: Endpoint,
    requestedModel: string,
    need: Set<Capability>,
    body: Record<string, unknown>,
    stream: boolean,
  ) {
    const principal = req.principal!;
    const deadlineMs = deadlineFor(req, deps);
    const deadlineAt = performance.now() + deadlineMs;
    const explain = req.headers[EXPLAIN_HEADER] === 'true';

    const [all, policy] = await Promise.all([
      candidates.forTenant(principal.tenantId),
      candidates.policyFor(principal.tenantId, principal.applicationId),
    ]);
    const ranking = rankCandidates(all, {
      requested: requestedModel,
      need,
      policy,
      cooldown: (id) => cooldowns.get(id),
    });
    if (!('plan' in ranking)) {
      if (explain)
        reply.header(
          'x-arc-route-explain',
          explainHeader(ranking.verdicts, 'rejected' in ranking ? ranking.rejected : {}, []),
        );
      throw selectionError(ranking, requestedModel);
    }

    const clientAbort = new AbortController();
    // Response 'close' before it finished = the client went away: cancel upstream.
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) clientAbort.abort();
    });

    const overheadMs = round(elapsed(req));
    const attempts: Attempt[] = [];
    let lastError: ArcError | null = null;
    const logBase = {
      event: 'inference',
      endpoint,
      tenantId: principal.tenantId,
      app: principal.applicationSlug,
      apiKeyId: principal.apiKeyId,
      requestedModel,
      stream,
      overheadMs,
    };

    for (const c of ranking.plan.slice(0, deps.maxAttempts)) {
      const remaining = deadlineAt - performance.now();
      if (attempts.length > 0 && remaining < deps.minAttemptMs) break;
      // Policy is re-checked at every step: fallback can never widen what is allowed.
      if (!passesPolicy(c, policy) || cooldowns.get(c.accountId)) continue;

      const apiKey = credentials.open(principal.tenantId, c.credentialId, c.sealed);
      const attemptTimeout = AbortSignal.timeout(Math.max(1, Math.floor(remaining)));
      const signal = AbortSignal.any([clientAbort.signal, attemptTimeout]);
      const attemptStart = elapsed(req);

      let upstream: Response;
      try {
        upstream = await gateway.dispatch({ endpoint, candidate: c, apiKey, body, stream, signal });
      } catch {
        if (clientAbort.signal.aborted) {
          req.log.info(
            { ...logBase, outcome: 'client_cancelled', attempts: attempts.length + 1 },
            'inference',
          );
          return reply;
        }
        if (attemptTimeout.aborted) {
          observations.record(c.accountId, c.modelUuid, 'timeout');
          cooldowns.failed(c.accountId);
          attempts.push({ candidate: c, failure: 'timeout' });
          lastError = new ArcError(504, 'deadline_exceeded', `No response within ${deadlineMs}ms`);
          continue;
        }
        // The gateway itself is down: every route goes through it, so fallback cannot help.
        throw new ArcError(502, 'gateway_unavailable', 'The inference gateway is unavailable');
      }
      const ttfbMs = round(elapsed(req));

      if (!upstream.ok) {
        const { error, kind } = await upstreamFailure(upstream, apiKey, c);
        if (kind === 'client_error') {
          req.log.info(
            { ...logBase, outcome: 'provider_rejected', upstreamStatus: upstream.status },
            'inference',
          );
          throw error;
        }
        observations.record(c.accountId, c.modelUuid, OUTCOME[kind]);
        attempts.push({ candidate: c, failure: kind, status: upstream.status });
        lastError = error;
        continue;
      }

      // Success: commit to this route.
      cooldowns.succeeded(c.accountId);
      observations.record(c.accountId, c.modelUuid, 'success', ttfbMs - attemptStart);
      reply.headers({
        'x-arc-route-provider': c.providerId,
        'x-arc-route-model': publicModelName(c),
        'x-arc-route-account': c.accountId,
        'x-arc-route-alternatives': String(ranking.plan.length - 1),
        'x-arc-route-attempts': String(attempts.length + 1),
        'x-arc-mode':
          isAlias(requestedModel) && requestedModel !== 'auto' ? requestedModel.slice(4) : 'fast',
        'x-arc-overhead-ms': String(overheadMs),
        ...(attempts.length
          ? {
              'x-arc-fallback': attempts.map((a) => a.failure).join(','),
              'x-arc-fallback-ms': String(round(attemptStart - overheadMs)),
            }
          : {}),
        ...(explain
          ? { 'x-arc-route-explain': explainHeader(ranking.verdicts, ranking.rejected, attempts) }
          : {}),
      });
      const routeLog = {
        ...logBase,
        provider: c.providerId,
        model: publicModelName(c),
        accountId: c.accountId,
        attempts: attempts.length + 1,
        fallback: attempts.map((a) => ({
          accountId: a.candidate.accountId,
          failure: a.failure,
          status: a.status,
        })),
        ttfbMs,
      };

      if (stream && upstream.body) {
        let firstChunkMs: number | undefined;
        const timed = upstream.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              firstChunkMs ??= round(elapsed(req));
              controller.enqueue(chunk);
            },
          }),
        );
        const out = Readable.fromWeb(timed as NodeReadableStream);
        out.on('close', () => {
          req.log.info(
            {
              ...routeLog,
              outcome: clientAbort.signal.aborted
                ? 'client_cancelled'
                : attemptTimeout.aborted
                  ? 'deadline_exceeded'
                  : 'ok',
              firstChunkMs,
              totalMs: round(elapsed(req)),
            },
            'inference',
          );
        });
        out.on('error', () => undefined);
        return reply
          .code(200)
          .headers({
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'x-accel-buffering': 'no',
          })
          .send(out);
      }

      const text = await upstream.text();
      let usage: unknown;
      try {
        usage = (JSON.parse(text) as { usage?: unknown }).usage;
      } catch {
        /* forward as-is */
      }
      req.log.info(
        { ...routeLog, outcome: 'ok', totalMs: round(elapsed(req)), usage },
        'inference',
      );
      return reply.code(200).header('content-type', 'application/json').send(text);
    }

    req.log.info(
      {
        ...logBase,
        outcome: 'all_attempts_failed',
        fallback: attempts.map((a) => ({ accountId: a.candidate.accountId, failure: a.failure })),
      },
      'inference',
    );
    if (attempts.length) reply.header('x-arc-fallback', attempts.map((a) => a.failure).join(','));
    if (explain)
      reply.header(
        'x-arc-route-explain',
        explainHeader(ranking.verdicts, ranking.rejected, attempts),
      );
    throw (
      lastError ??
      new ArcError(
        503,
        'no_eligible_route',
        `No eligible provider key for "${requestedModel}" right now`,
      )
    );
  }

  app.get('/models', async (req) => {
    const principal = requireScope(req, 'models:read');
    const [all, policy] = await Promise.all([
      candidates.forTenant(principal.tenantId),
      candidates.policyFor(principal.tenantId, principal.applicationId),
    ]);
    const byName = new Map<
      string,
      { provider: string; capabilities: Set<Capability>; eligibility: Set<string> }
    >();
    for (const c of all) {
      if (!passesPolicy(c, policy) || c.health === 'invalid_credentials') continue;
      if (policy.allowedJurisdictions && !policy.allowedJurisdictions.has(c.jurisdiction)) continue;
      const name = publicModelName(c);
      const entry = byName.get(name) ?? {
        provider: c.providerId,
        capabilities: new Set(),
        eligibility: new Set(),
      };
      for (const cap of c.capabilities) entry.capabilities.add(cap);
      entry.eligibility.add(c.eligibility);
      byName.set(name, entry);
    }
    const created = 0;
    const aliases = byName.size
      ? ALIASES.map((id) => ({ id, object: 'model', created, owned_by: 'arc' }))
      : [];
    const models = [...byName.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, e]) => ({
        id,
        object: 'model',
        created,
        owned_by: e.provider,
        arc: { capabilities: [...e.capabilities].sort(), eligibility: [...e.eligibility].sort() },
      }));
    return { object: 'list', data: [...aliases, ...models] };
  });

  app.post('/chat/completions', { bodyLimit: deps.bodyLimitBytes }, async (req, reply) => {
    requireScope(req, 'inference');
    const body = parseInput(chatRequestSchema, req.body);
    return execute(
      req,
      reply,
      'chat/completions',
      body.model,
      requiredChatCapabilities(body),
      chatPassthrough(body),
      body.stream === true,
    );
  });

  app.post('/embeddings', { bodyLimit: deps.bodyLimitBytes }, async (req, reply) => {
    requireScope(req, 'inference');
    const body = parseInput(embeddingRequestSchema, req.body);
    return execute(
      req,
      reply,
      'embeddings',
      body.model,
      new Set<Capability>(['embeddings']),
      embeddingPassthrough(body),
      false,
    );
  });
}
