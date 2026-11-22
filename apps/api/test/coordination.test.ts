import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createOwner } from '../src/auth/owner.js';
import { RedisBus } from '../src/coordination/bus.js';
import { RedisRateLimiter } from '../src/coordination/rate-limit.js';
import type { Db } from '../src/db/pool.js';
import { CandidateStore } from '../src/inference/candidates.js';
import { Cooldowns } from '../src/inference/cooldowns.js';
import { ObservationRecorder } from '../src/inference/observations.js';
import { ApiKeyVerifier } from '../src/keys/verifier.js';
import { ArcMetrics } from '../src/observability/metrics.js';
import { startHealthMonitor } from '../src/observability/monitor.js';
import { HttpProviderProbe } from '../src/providers/probe.js';
import { CredentialService } from '../src/vault/credentials.js';
import { generateKeyFile, parseKeyRing } from '../src/vault/vault.js';
import { TEST_DATABASE_URL, createTestDatabase } from './helpers/db.js';
import { DirectGateway } from './helpers/direct-gateway.js';
import { type MockProvider, startMockProvider } from './helpers/mock-provider.js';

const TEST_REDIS_URL = process.env.TEST_REDIS_URL;
// This suite empties its Redis database before every test. Test files run in parallel, so it
// gets a database of its own (the next index after TEST_REDIS_URL's), and its flush can't wipe
// keys another file (the sign-in throttle test, for one) is in the middle of checking.
const COORD_REDIS_URL = (() => {
  if (!TEST_REDIS_URL) return undefined;
  const u = new URL(TEST_REDIS_URL);
  const index = Number(u.pathname.slice(1)) || 0;
  u.pathname = `/${(index + 1) % 16}`;
  return u.toString();
})();
const OWNER = { email: 'owner@arc.test', password: 'owner-password-123' };

interface Instance {
  app: FastifyInstance;
  bus: RedisBus;
  cooldowns: Cooldowns;
  metrics: ArcMetrics;
  redis: Redis;
}

describe.skipIf(!TEST_DATABASE_URL || !TEST_REDIS_URL)(
  'multi-instance coordination via Redis (PostgreSQL + Redis)',
  () => {
    let db: Db;
    let drop: () => Promise<void>;
    let mock: MockProvider;
    let a: Instance;
    let b: Instance;
    let ownerCookie: string;
    let echoAppId: string;
    let arcKey: string;
    const accountIds: string[] = [];
    const RATE_LIMIT = 6;
    const keyring = parseKeyRing(generateKeyFile());

    /** One ARC API instance wired exactly like main.ts (own caches, shared DB and Redis). */
    function instance(): Instance {
      const credentials = new CredentialService(keyring);
      const verifier = new ApiKeyVerifier(db);
      const candidates = new CandidateStore(db);
      const cooldowns = new Cooldowns();
      const bus = new RedisBus(COORD_REDIS_URL!);
      const redis = new Redis(COORD_REDIS_URL!, { maxRetriesPerRequest: 1 });
      const metrics = new ArcMetrics();
      bus.subscribe((e) => {
        if (e.type === 'api_key_revoked') verifier.invalidate(e.keyId);
        else if (e.type === 'routing_changed') candidates.invalidate();
        else if (e.type === 'cooldown') cooldowns.apply(e.accountId, e.reason, e.seconds);
      });
      cooldowns.onCooldown = (accountId, reason, seconds) =>
        bus.publish({ type: 'cooldown', accountId, reason, seconds });
      const app = buildApp({
        checks: [],
        readinessTimeoutMs: 100,
        admin: {
          db,
          credentials,
          probe: new HttpProviderProbe(),
          cookieSecure: false,
          sessionTtlMs: 3_600_000,
          probeTimeoutMs: 2000,
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
          observations: new ObservationRecorder(db, 3_600_000),
          gateway: new DirectGateway(),
          defaultDeadlineMs: 10_000,
          maxDeadlineMs: 20_000,
          bodyLimitBytes: 1024 * 1024,
          requestsPerMinute: RATE_LIMIT,
          rateLimiter: new RedisRateLimiter(redis, RATE_LIMIT),
          maxAttempts: 3,
          minAttemptMs: 100,
          metrics,
        },
      });
      return { app, bus, cooldowns, metrics, redis };
    }

    const chat = (inst: Instance, key = arcKey) =>
      inst.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${key}` },
        payload: { model: 'llama-cpp/mock-chat', messages: [{ role: 'user', content: 'hi' }] },
      });

    const admin =
      (inst: Instance) =>
      (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
        inst.app.inject({
          method,
          url: `/admin/v1${url}`,
          headers: { cookie: ownerCookie },
          ...(payload ? { payload } : {}),
        });

    /** Pub/sub is asynchronous: wait (briefly) for a condition instead of sleeping blindly. */
    async function eventually(check: () => Promise<boolean> | boolean, ms = 1000): Promise<void> {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('condition not met in time');
    }

    async function newKey(name: string): Promise<string> {
      return (await admin(a)('POST', `/applications/${echoAppId}/api-keys`, { name })).json().key;
    }

    beforeAll(async () => {
      ({ db, drop } = await createTestDatabase());
      mock = await startMockProvider();
      a = instance();
      b = instance();
      expect(await a.bus.ready()).toBe(true);
      expect(await b.bus.ready()).toBe(true);

      await createOwner(db, OWNER);
      const login: LightMyRequestResponse = await a.app.inject({
        method: 'POST',
        url: '/admin/v1/auth/login',
        payload: OWNER,
      });
      ownerCookie = `arc_session=${login.cookies.find((c) => c.name === 'arc_session')!.value}`;
      for (const label of ['K1', 'K2']) {
        const res = await admin(a)('POST', '/provider-accounts', {
          providerId: 'llama-cpp',
          label,
          apiKey: `provider-${label}-0000`,
          baseUrl: mock.url,
        });
        accountIds.push(res.json().id);
        await admin(a)('POST', `/provider-accounts/${res.json().id}/validate`);
      }
      for (const m of (await admin(a)('GET', '/models?provider=llama-cpp')).json().data as Array<{
        id: string;
      }>) {
        await admin(a)('PATCH', `/models/${m.id}`, {
          eligibility: 'VERIFIED_FREE',
          eligibilityEvidenceUrl: 'https://example.test/terms',
          capabilities: ['text', 'streaming', 'embeddings'],
          enabled: true,
        });
      }
      echoAppId = (
        await admin(a)('POST', '/applications', { name: 'Echo', slug: 'echo', firstParty: true })
      ).json().id;
      arcKey = await newKey('main');
    }, 60_000);

    afterAll(async () => {
      for (const inst of [a, b]) {
        await inst?.app.close();
        await inst?.bus.close();
        await inst?.redis.quit();
      }
      await mock?.close();
      await drop?.();
    });

    beforeEach(async () => {
      a.cooldowns.clear();
      b.cooldowns.clear();
      await a.redis.flushdb();
    });

    it('a key revoked on one instance is rejected by the other immediately (not after the 30 s cache)', async () => {
      const key = await newKey('to-revoke');
      expect((await chat(b, key)).statusCode).toBe(200); // B now has it cached
      const keyId = (await admin(a)('GET', `/applications/${echoAppId}/api-keys`))
        .json()
        .data.find((k: { name: string }) => k.name === 'to-revoke').id;
      expect((await admin(a)('DELETE', `/api-keys/${keyId}`)).statusCode).toBe(204);
      await eventually(async () => (await chat(b, key)).statusCode === 401);
    });

    it('routing changes on one instance invalidate the others immediately', async () => {
      expect((await chat(b)).statusCode).toBe(200); // B caches both keys as routable
      for (const id of accountIds)
        await admin(a)('PATCH', `/provider-accounts/${id}`, { enabled: false });
      await eventually(async () => (await chat(b)).statusCode === 404);
      for (const id of accountIds)
        await admin(a)('PATCH', `/provider-accounts/${id}`, { enabled: true });
      await eventually(async () => (await chat(b)).statusCode === 200);
    });

    it('a cooldown learned on one instance is honoured by the other', async () => {
      const [k1] = accountIds;
      a.cooldowns.rateLimited(k1!, 60);
      await eventually(() => b.cooldowns.get(k1!) === 'rate_limited');
      for (let i = 0; i < 3; i++) {
        const res = await chat(b);
        expect(res.headers['x-arc-route-account']).not.toBe(k1);
      }
    });

    it('the per-key rate limit is shared across instances', async () => {
      const key = await newKey('limited');
      const statuses: number[] = [];
      for (let i = 0; i < RATE_LIMIT; i++)
        statuses.push((await chat(i % 2 ? b : a, key)).statusCode);
      expect(statuses.every((s) => s === 200)).toBe(true);
      const over = await chat(b, key);
      expect(over.statusCode).toBe(429);
      expect(over.json().error.code).toBe('arc_rate_limited');
    });

    it('exposes metrics segmented by provider, model, key, app and mode', async () => {
      await chat(a);
      const text = await a.metrics.registry.metrics();
      expect(text).toMatch(
        /arc_overhead_ms_count\{endpoint="chat\/completions",mode="fast",app="echo"\} \d+/,
      );
      expect(text).toMatch(
        /arc_requests_total\{endpoint="chat\/completions",provider="llama-cpp",model="llama-cpp\/mock-chat",account="[0-9a-f-]{36}",app="echo",mode="fast",outcome="ok"\}/,
      );
      expect(text).toContain('arc_provider_ttfb_ms_bucket');
      expect(text).not.toContain('hi'.repeat(1) + '"'); // no message content in labels
    });

    it('counts fallbacks and routing failures', async () => {
      mock.failWith = 503;
      await chat(a);
      mock.failWith = null;
      const text = await a.metrics.registry.metrics();
      expect(text).toMatch(/arc_fallbacks_total\{reason="provider_error"\} \d+/);
      const missing = await a.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${arcKey}` },
        payload: { model: 'nope/unknown', messages: [{ role: 'user', content: 'x' }] },
      });
      expect(missing.statusCode).toBe(404);
      expect(await a.metrics.registry.metrics()).toMatch(
        /arc_routing_failures_total\{reason="unknown_model",app="echo"\} 1/,
      );
    });

    it('reports dependency health and worker heartbeat age', async () => {
      await db.query(
        "INSERT INTO worker_heartbeats (worker_id, hostname, started_at, last_seen) VALUES ('w1', 'h', now(), now() - interval '90 seconds')",
      );
      const stop = startHealthMonitor({
        db,
        metrics: a.metrics,
        timeoutMs: 100,
        checks: [
          { name: 'postgres', check: async () => void (await db.query('SELECT 1')) },
          { name: 'litellm', check: async () => Promise.reject(new Error('down')) },
        ],
      });
      // An unset gauge already prints 0, so wait for a real (positive) age.
      await eventually(async () => {
        const m = /arc_worker_heartbeat_age_seconds (\d+(\.\d+)?)/.exec(
          await a.metrics.registry.metrics(),
        );
        return !!m && Number(m[1]) > 0;
      });
      stop();
      const text = await a.metrics.registry.metrics();
      expect(text).toContain('arc_dependency_up{name="postgres"} 1');
      expect(text).toContain('arc_dependency_up{name="litellm"} 0');
      const age = Number(/arc_worker_heartbeat_age_seconds (\d+(\.\d+)?)/.exec(text)![1]);
      expect(age).toBeGreaterThanOrEqual(89);
    });
  },
);

describe('RedisRateLimiter without a healthy Redis', () => {
  it('falls back to the local limiter within its timeout instead of blocking requests', async () => {
    const hanging = {
      multi: () => ({
        incr: () => ({ expire: () => ({ exec: () => new Promise(() => undefined) }) }),
      }),
    };
    const limiter = new RedisRateLimiter(hanging as unknown as Redis, 2, 30);
    const started = Date.now();
    expect(await limiter.hit('k')).toBe(true);
    expect(await limiter.hit('k')).toBe(true);
    expect(await limiter.hit('k')).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
    expect(limiter.degraded).toBe(3);
  });
});
