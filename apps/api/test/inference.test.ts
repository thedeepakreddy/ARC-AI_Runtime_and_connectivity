import type { AddressInfo } from 'node:net';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createOwner } from '../src/auth/owner.js';
import { hashPassword } from '../src/auth/password.js';
import type { Db } from '../src/db/pool.js';
import { CandidateStore } from '../src/inference/candidates.js';
import { Cooldowns } from '../src/inference/cooldowns.js';
import { ObservationRecorder } from '../src/inference/observations.js';
import {
  type DispatchInput,
  type InferenceGateway,
  LiteLLMGateway,
  litellmTarget,
} from '../src/inference/gateway.js';
import { ApiKeyVerifier } from '../src/keys/verifier.js';
import { HttpProviderProbe } from '../src/providers/probe.js';
import { CredentialService } from '../src/vault/credentials.js';
import { generateKeyFile, parseKeyRing } from '../src/vault/vault.js';
import { TEST_DATABASE_URL, createTestDatabase } from './helpers/db.js';
import { type MockProvider, startMockProvider } from './helpers/mock-provider.js';
import { tamperLastChar } from './helpers/tamper.js';

/**
 * Stand-in for LiteLLM when no LiteLLM is running: forwards to the OpenAI-compatible
 * provider exactly as LiteLLM would (key as Bearer, model without the "openai/" prefix).
 */
class DirectGateway implements InferenceGateway {
  dispatch(input: DispatchInput): Promise<Response> {
    const t = litellmTarget(input.candidate);
    return fetch(`${t.apiBase}/${input.endpoint}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...input.body,
        model: t.model.replace(/^openai\//, ''),
        stream: input.stream,
      }),
      signal: input.signal,
    });
  }
}

const LITELLM_TEST_URL = process.env.LITELLM_TEST_URL;
const LITELLM_TEST_MASTER_KEY = process.env.LITELLM_TEST_MASTER_KEY ?? 'sk-test-master';
const OWNER = { email: 'owner@arc.test', password: 'owner-password-123' };
const CUSTOMER = { email: 'cust@example.test', password: 'customer-password-123' };
const PROVIDER_KEY_A = 'local-provider-key-AAAA';
const PROVIDER_KEY_B = 'local-provider-key-BBBB';

describe.skipIf(!TEST_DATABASE_URL)(
  `inference API via ${LITELLM_TEST_URL ? 'real LiteLLM' : 'direct gateway'} (PostgreSQL)`,
  () => {
    let db: Db;
    let drop: () => Promise<void>;
    let app: FastifyInstance;
    let base: string;
    let mock: MockProvider;
    let ownerCookie: string;
    let customerCookie: string;
    let echoAppId: string;
    let arcKey: string;
    let arcKeyId: string;
    const accountIds: string[] = [];
    let chatModelUuid: string;
    const candidates = { store: undefined as unknown as CandidateStore };
    let cooldowns: Cooldowns;

    const admin =
      (cookie: string) =>
      (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
        app.inject({
          method,
          url: `/admin/v1${url}`,
          headers: { cookie },
          ...(payload ? { payload } : {}),
        });

    const v1 = (
      method: 'GET' | 'POST',
      url: string,
      payload?: object,
      headers: Record<string, string> = {},
    ) =>
      app.inject({
        method,
        url: `/v1${url}`,
        headers: { authorization: `Bearer ${arcKey}`, ...headers },
        ...(payload ? { payload } : {}),
      });

    const chat = (extra: object = {}, headers: Record<string, string> = {}) =>
      v1(
        'POST',
        '/chat/completions',
        { model: 'auto', messages: [{ role: 'user', content: 'hi' }], ...extra },
        headers,
      );

    function cookieOf(res: LightMyRequestResponse): string {
      return `arc_session=${res.cookies.find((c) => c.name === 'arc_session')!.value}`;
    }

    beforeAll(async () => {
      ({ db, drop } = await createTestDatabase());
      mock = await startMockProvider();
      const credentials = new CredentialService(parseKeyRing(generateKeyFile()));
      const verifier = new ApiKeyVerifier(db);
      candidates.store = new CandidateStore(db);
      cooldowns = new Cooldowns();
      const gateway = LITELLM_TEST_URL
        ? new LiteLLMGateway(LITELLM_TEST_URL, LITELLM_TEST_MASTER_KEY)
        : new DirectGateway();

      app = buildApp({
        checks: [],
        readinessTimeoutMs: 100,
        admin: {
          db,
          credentials,
          probe: new HttpProviderProbe(),
          cookieSecure: false,
          sessionTtlMs: 3_600_000,
          probeTimeoutMs: 2000,
          onRoutingChange: () => candidates.store.invalidate(),
          onApiKeyRevoked: (keyId) => verifier.invalidate(keyId),
        },
        inference: {
          db,
          credentials,
          verifier,
          candidates: candidates.store,
          cooldowns,
          observations: new ObservationRecorder(db),
          gateway,
          defaultDeadlineMs: 10_000,
          maxDeadlineMs: 20_000,
          bodyLimitBytes: 1024 * 1024,
          requestsPerMinute: 1000,
          maxAttempts: 3,
          minAttemptMs: 100,
        },
      });
      await app.listen({ host: '127.0.0.1', port: 0 });
      base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

      await createOwner(db, OWNER);
      const login = (e: string, p: string) =>
        app.inject({
          method: 'POST',
          url: '/admin/v1/auth/login',
          payload: { email: e, password: p },
        });
      ownerCookie = cookieOf(await login(OWNER.email, OWNER.password));

      const t = await db.query<{ id: string }>(
        "INSERT INTO tenants (kind, name) VALUES ('organization', 'Cust') RETURNING id",
      );
      const u = await db.query<{ id: string }>(
        'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
        [CUSTOMER.email, await hashPassword(CUSTOMER.password)],
      );
      await db.query(
        "INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')",
        [t.rows[0]!.id, u.rows[0]!.id],
      );
      customerCookie = cookieOf(await login(CUSTOMER.email, CUSTOMER.password));

      // Two keys for the same (OpenAI-compatible, self-hosted) provider, pointed at the mock.
      const call = admin(ownerCookie);
      for (const [label, apiKey] of [
        ['Local A', PROVIDER_KEY_A],
        ['Local B', PROVIDER_KEY_B],
      ]) {
        const res = await call('POST', '/provider-accounts', {
          providerId: 'llama-cpp',
          label,
          apiKey,
          baseUrl: mock.url,
        });
        expect(res.statusCode).toBe(201);
        accountIds.push(res.json().id);
        const v = await call('POST', `/provider-accounts/${res.json().id}/validate`);
        expect(v.json()).toMatchObject({ status: 'healthy', modelsSeen: 2 });
      }

      // Classify discovered models with evidence, then enable them.
      const models = (await call('GET', '/models?provider=llama-cpp')).json().data as Array<{
        id: string;
        modelId: string;
      }>;
      for (const m of models) {
        const isEmbed = m.modelId === 'mock-embed';
        const res = await call('PATCH', `/models/${m.id}`, {
          eligibility: 'VERIFIED_FREE',
          eligibilityEvidenceUrl: 'https://example.test/self-hosted',
          capabilities: isEmbed ? ['embeddings'] : ['text', 'streaming'],
          enabled: true,
        });
        expect(res.statusCode).toBe(200);
        if (!isEmbed) chatModelUuid = m.id;
      }

      const appRes = await call('POST', '/applications', {
        name: 'Echo',
        slug: 'echo',
        firstParty: true,
      });
      echoAppId = appRes.json().id;
      const keyRes = await call('POST', `/applications/${echoAppId}/api-keys`, {
        name: 'Echo production',
      });
      expect(keyRes.statusCode).toBe(201);
      arcKey = keyRes.json().key;
      arcKeyId = keyRes.json().id;
    }, 60_000);

    afterAll(async () => {
      // Streams cut off by clients can leave half-closed sockets; production shutdown does the same.
      app?.server.closeAllConnections();
      await app?.close();
      await mock?.close();
      await drop?.();
    });

    beforeEach(() => {
      cooldowns.clear();
      mock.failWith = null;
      mock.responseDelayMs = 0;
      mock.chunks = 3;
      mock.chunkDelayMs = 5;
      mock.seenAuth = [];
    });

    describe('ARC API keys', () => {
      it('issues keys in the ARC_DEE_…_PAK_… format and shows them only once', async () => {
        expect(arcKey).toMatch(/^ARC_DEE_[0-9A-Za-z]{17}_PAK_[0-9A-Za-z]{43}$/);
        const list = await admin(ownerCookie)('GET', `/applications/${echoAppId}/api-keys`);
        expect(list.body).not.toContain(arcKey);
        expect(list.json().data[0].displayPrefix).toMatch(/^ARC_DEE_.+_PAK_….{4}$/);
        const { rows } = await db.query('SELECT secret_hash FROM api_keys');
        expect(JSON.stringify(rows)).not.toContain(arcKey.split('_PAK_')[1]);
      });

      it('rejects missing and invalid keys with OpenAI-style errors', async () => {
        const none = await app.inject({ method: 'GET', url: '/v1/models' });
        expect(none.statusCode).toBe(401);
        expect(none.json().error).toMatchObject({
          type: 'authentication_error',
          code: 'missing_api_key',
        });
        const bad = await app.inject({
          method: 'GET',
          url: '/v1/models',
          headers: { authorization: `Bearer ${tamperLastChar(arcKey)}` },
        });
        expect(bad.json().error.code).toBe('invalid_api_key');
      });

      it('enforces scopes', async () => {
        const res = await admin(ownerCookie)('POST', `/applications/${echoAppId}/api-keys`, {
          name: 'read only',
          scopes: ['models:read'],
        });
        const readOnly = res.json().key as string;
        const models = await app.inject({
          method: 'GET',
          url: '/v1/models',
          headers: { authorization: `Bearer ${readOnly}` },
        });
        expect(models.statusCode).toBe(200);
        const chatRes = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: { authorization: `Bearer ${readOnly}` },
          payload: { model: 'auto', messages: [{ role: 'user', content: 'x' }] },
        });
        expect(chatRes.statusCode).toBe(403);
      });

      it('revocation takes effect immediately, and rotation issues a working replacement', async () => {
        const res = await admin(ownerCookie)('POST', `/applications/${echoAppId}/api-keys`, {
          name: 'temp',
        });
        const temp = res.json().key as string;
        const auth = { authorization: `Bearer ${temp}` };
        expect(
          (await app.inject({ method: 'GET', url: '/v1/models', headers: auth })).statusCode,
        ).toBe(200);

        const rotated = await admin(ownerCookie)('POST', `/api-keys/${res.json().id}/rotate`);
        expect(rotated.statusCode).toBe(201);
        expect(
          (await app.inject({ method: 'GET', url: '/v1/models', headers: auth })).statusCode,
        ).toBe(401);
        const fresh = { authorization: `Bearer ${rotated.json().key}` };
        expect(
          (await app.inject({ method: 'GET', url: '/v1/models', headers: fresh })).statusCode,
        ).toBe(200);

        expect(
          (await admin(ownerCookie)('DELETE', `/api-keys/${rotated.json().id}`)).statusCode,
        ).toBe(204);
        expect(
          (await app.inject({ method: 'GET', url: '/v1/models', headers: fresh })).statusCode,
        ).toBe(401);
      });
    });

    describe('/v1/models', () => {
      it('lists aliases and the routable models with capabilities', async () => {
        const res = await v1('GET', '/models');
        const ids = res.json().data.map((m: { id: string }) => m.id);
        expect(ids).toEqual([
          'auto',
          'arc/fast',
          'arc/balanced',
          'arc/deep',
          'llama-cpp/mock-chat',
          'llama-cpp/mock-embed',
        ]);
        const chatModel = res
          .json()
          .data.find((m: { id: string }) => m.id === 'llama-cpp/mock-chat');
        expect(chatModel.arc.capabilities).toEqual(['streaming', 'text']);
      });
    });

    describe('/v1/chat/completions', () => {
      it('routes "auto" to an eligible model and uses that key', async () => {
        const res = await chat();
        expect(res.statusCode).toBe(200);
        expect(res.json().choices[0].message.content).toBe('Hello from mock');
        expect(res.headers['x-arc-route-model']).toBe('llama-cpp/mock-chat');
        expect(accountIds).toContain(res.headers['x-arc-route-account']);
        expect(res.headers['x-arc-route-alternatives']).toBe('1');
        expect(Number(res.headers['x-arc-overhead-ms'])).toBeGreaterThanOrEqual(0);
        expect(mock.seenAuth).toHaveLength(1);
        expect([`Bearer ${PROVIDER_KEY_A}`, `Bearer ${PROVIDER_KEY_B}`]).toContain(
          mock.seenAuth[0],
        );
      });

      it('accepts explicit provider/model names', async () => {
        const res = await chat({ model: 'llama-cpp/mock-chat' });
        expect(res.statusCode).toBe(200);
      });

      it('ignores credential/routing fields injected by the client', async () => {
        const res = await chat({ api_key: 'attacker-key', api_base: 'https://evil.example/v1' });
        expect(res.statusCode).toBe(200);
        expect(mock.seenAuth[0]).not.toContain('attacker-key');
      });

      it('streams chunks as they arrive instead of buffering', async () => {
        mock.chunks = 4;
        mock.chunkDelayMs = 150;
        const started = Date.now();
        const res = await fetch(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${arcKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'auto',
            stream: true,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/event-stream');
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let text = '';
        let firstChunkAt = 0;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!firstChunkAt && value.length) firstChunkAt = Date.now() - started;
          text += decoder.decode(value, { stream: true });
        }
        const totalMs = Date.now() - started;
        expect(text).toContain('tok0');
        expect(text).toContain('data: [DONE]');
        // 4 chunks 150 ms apart: the first must arrive well before the stream ends.
        expect(totalMs - firstChunkAt).toBeGreaterThan(300);
      });

      it('cancels the provider stream when the client disconnects', async () => {
        mock.chunks = 100;
        mock.chunkDelayMs = 30;
        mock.streamAborted = false;
        const controller = new AbortController();
        const res = await fetch(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${arcKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'auto',
            stream: true,
            messages: [{ role: 'user', content: 'hi' }],
          }),
          signal: controller.signal,
        });
        const reader = res.body!.getReader();
        await reader.read();
        controller.abort();
        await new Promise((r) => setTimeout(r, 800));
        expect(mock.streamAborted).toBe(true);
      });

      it('enforces the request deadline', async () => {
        mock.responseDelayMs = 1500;
        const res = await chat({}, { 'x-arc-deadline-ms': '300' });
        expect(res.statusCode).toBe(504);
        expect(res.json().error.code).toBe('deadline_exceeded');
      });

      it('rejects requests needing capabilities no eligible model has', async () => {
        const res = await chat({
          tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toMatchObject({
          code: 'capability_not_supported',
          details: { missing: ['tools'] },
        });
      });

      it('returns model_not_found for unknown models', async () => {
        const res = await chat({ model: 'groq/not-registered' });
        expect(res.statusCode).toBe(404);
        expect(res.json().error.code).toBe('model_not_found');
      });

      it('maps provider rate limits to 429 without leaking the provider key', async () => {
        mock.failWith = 429;
        const res = await chat();
        expect(res.statusCode).toBe(429);
        expect(res.json().error.code).toBe('provider_rate_limited');
        expect(res.body).not.toContain('local-provider-key');
        // Both keys were tried (fallback), each was rate limited.
        expect(res.headers['x-arc-fallback']).toBe('rate_limited,rate_limited');
        await db.query("UPDATE provider_accounts SET health_status = 'healthy'");
        candidates.store.invalidate();
      });

      it('maps provider auth failures to 502 and marks the failing keys invalid', async () => {
        mock.failWith = 401;
        const res = await chat();
        expect(res.statusCode).toBe(502);
        expect(res.json().error.code).toBe('provider_auth_failed');
        expect(res.headers['x-arc-fallback']).toBe('auth_failed,auth_failed');
        await new Promise((r) => setTimeout(r, 100));
        const { rows } = await db.query(
          'SELECT health_status FROM provider_accounts WHERE id = ANY($1)',
          [accountIds],
        );
        expect(rows.map((r) => r.health_status)).toEqual([
          'invalid_credentials',
          'invalid_credentials',
        ]);
        await db.query("UPDATE provider_accounts SET health_status = 'healthy'");
        candidates.store.invalidate();
      });

      it('blocks a model reclassified as PAID for owner keys (free-only policy)', async () => {
        const call = admin(ownerCookie);
        await call('PATCH', `/models/${chatModelUuid}`, {
          eligibility: 'PAID',
          eligibilityEvidenceUrl: 'https://example.test/pricing',
        });
        const res = await chat({ model: 'llama-cpp/mock-chat' });
        expect(res.statusCode).toBe(503);
        expect(res.json().error.code).toBe('no_eligible_route');
        await call('PATCH', `/models/${chatModelUuid}`, {
          eligibility: 'VERIFIED_FREE',
          eligibilityEvidenceUrl: 'https://example.test/self-hosted',
          enabled: true,
        });
        expect((await chat()).statusCode).toBe(200);
      });
    });

    describe('/v1/embeddings', () => {
      it('routes embeddings to an embeddings-capable model', async () => {
        const res = await v1('POST', '/embeddings', { model: 'auto', input: ['a', 'b'] });
        expect(res.statusCode).toBe(200);
        expect(res.json().data).toHaveLength(2);
        expect(res.headers['x-arc-route-model']).toBe('llama-cpp/mock-embed');
      });
    });

    describe('tenant isolation', () => {
      it("a customer's ARC key cannot use the owner's private provider keys", async () => {
        const call = admin(customerCookie);
        const appRes = await call('POST', '/applications', { name: 'Cust app', slug: 'cust-app' });
        const key = (
          await call('POST', `/applications/${appRes.json().id}/api-keys`, { name: 'k' })
        ).json().key as string;
        const auth = { authorization: `Bearer ${key}` };
        const models = await app.inject({ method: 'GET', url: '/v1/models', headers: auth });
        expect(models.json().data).toEqual([]);
        const res = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: auth,
          payload: { model: 'llama-cpp/mock-chat', messages: [{ role: 'user', content: 'x' }] },
        });
        expect(res.statusCode).toBe(404);
      });

      it("a customer cannot issue keys for the owner's applications", async () => {
        const res = await admin(customerCookie)('POST', `/applications/${echoAppId}/api-keys`, {
          name: 'x',
        });
        expect(res.statusCode).toBe(404);
        const del = await admin(customerCookie)('DELETE', `/api-keys/${arcKeyId}`);
        expect(del.statusCode).toBe(404);
      });
    });
  },
);
