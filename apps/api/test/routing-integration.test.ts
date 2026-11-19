import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createOwner } from '../src/auth/owner.js';
import { hashPassword } from '../src/auth/password.js';
import type { Db } from '../src/db/pool.js';
import { CandidateStore } from '../src/inference/candidates.js';
import { Cooldowns } from '../src/inference/cooldowns.js';
import {
  type DispatchInput,
  type InferenceGateway,
  litellmTarget,
} from '../src/inference/gateway.js';
import { ObservationRecorder } from '../src/inference/observations.js';
import { ApiKeyVerifier } from '../src/keys/verifier.js';
import { HttpProviderProbe } from '../src/providers/probe.js';
import { assertPublicHttpsUrl } from '../src/providers/url-guard.js';
import { CredentialService } from '../src/vault/credentials.js';
import { generateKeyFile, parseKeyRing } from '../src/vault/vault.js';
import { computeRouteScores, revalidateStaleAccounts } from '../src/worker/jobs.js';
import { TEST_DATABASE_URL, createTestDatabase } from './helpers/db.js';
import { type MockProvider, startMockProvider } from './helpers/mock-provider.js';

/** Forwards to the OpenAI-compatible mock exactly as LiteLLM would. */
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

const OWNER = { email: 'owner@arc.test', password: 'owner-password-123' };
const CUSTOMER = { email: 'cust@example.test', password: 'customer-password-123' };

describe.skipIf(!TEST_DATABASE_URL)(
  'Phase 3 routing: fallback, policy, ranking, worker (PostgreSQL)',
  () => {
    let db: Db;
    let drop: () => Promise<void>;
    let app: FastifyInstance;
    let credentials: CredentialService;
    let candidates: CandidateStore;
    const cooldowns = new Cooldowns();
    let observations: ObservationRecorder;
    let ownerCookie: string;
    let customerCookie: string;
    let arcKey: string;
    let echoAppId: string;
    /** accountId -> mock, plus friendly names. */
    const mockByAccount = new Map<string, MockProvider>();
    const ids: Record<'A' | 'B' | 'C', string> = { A: '', B: '', C: '' };
    const mocks: MockProvider[] = [];
    const modelIds: Record<string, string> = {};

    const admin =
      (cookie: string) =>
      (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
        app.inject({
          method,
          url: `/admin/v1${url}`,
          headers: { cookie },
          ...(payload ? { payload } : {}),
        });

    const chat = (extra: object = {}, headers: Record<string, string> = {}) =>
      app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${arcKey}`, ...headers },
        payload: { model: 'auto', messages: [{ role: 'user', content: 'hi' }], ...extra },
      });

    const explain = async (model: string, applicationId?: string) =>
      (
        await admin(ownerCookie)('POST', '/routing/explain', {
          model,
          ...(applicationId ? { applicationId } : {}),
        })
      ).json();

    const calls = (accountId: string) => mockByAccount.get(accountId)!.seenAuth.length;

    function cookieOf(res: LightMyRequestResponse): string {
      return `arc_session=${res.cookies.find((c) => c.name === 'arc_session')!.value}`;
    }

    beforeAll(async () => {
      ({ db, drop } = await createTestDatabase());
      for (let i = 0; i < 3; i++) mocks.push(await startMockProvider());
      credentials = new CredentialService(parseKeyRing(generateKeyFile()));
      const verifier = new ApiKeyVerifier(db);
      candidates = new CandidateStore(db);
      observations = new ObservationRecorder(db, 3_600_000);

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
          assertPublicUrl: (url) => assertPublicHttpsUrl(url, async () => ['8.8.8.8']),
          onRoutingChange: () => candidates.invalidate(),
          onApiKeyRevoked: (k) => verifier.invalidate(k),
          routing: { candidates, cooldowns },
        },
        inference: {
          db,
          credentials,
          verifier,
          candidates,
          cooldowns,
          observations,
          gateway: new DirectGateway(),
          defaultDeadlineMs: 10_000,
          maxDeadlineMs: 20_000,
          bodyLimitBytes: 1024 * 1024,
          requestsPerMinute: 10_000,
          maxAttempts: 3,
          minAttemptMs: 100,
        },
      });

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

      // A and B: two keys for the same self-hosted provider. C: a CN-jurisdiction provider.
      const call = admin(ownerCookie);
      const specs = [
        ['A', 'llama-cpp', mocks[0]!],
        ['B', 'llama-cpp', mocks[1]!],
        ['C', 'siliconflow', mocks[2]!],
      ] as const;
      for (const [name, providerId, mock] of specs) {
        const res = await call('POST', '/provider-accounts', {
          providerId,
          label: `Key ${name}`,
          apiKey: `provider-key-${name}-0000`,
          baseUrl: mock.url,
        });
        expect(res.statusCode).toBe(201);
        ids[name] = res.json().id;
        mockByAccount.set(res.json().id, mock);
        expect(
          (await call('POST', `/provider-accounts/${res.json().id}/validate`)).json().status,
        ).toBe('healthy');
      }
      for (const providerId of ['llama-cpp', 'siliconflow']) {
        for (const m of (await call('GET', `/models?provider=${providerId}`)).json().data as Array<{
          id: string;
          modelId: string;
        }>) {
          const embed = m.modelId === 'mock-embed';
          await call('PATCH', `/models/${m.id}`, {
            eligibility: 'VERIFIED_FREE',
            eligibilityEvidenceUrl: 'https://example.test/terms',
            capabilities: embed ? ['embeddings'] : ['text', 'streaming'],
            enabled: true,
          });
          modelIds[`${providerId}/${m.modelId}`] = m.id;
        }
      }
      echoAppId = (
        await call('POST', '/applications', { name: 'Echo', slug: 'echo', firstParty: true })
      ).json().id;
      arcKey = (await call('POST', `/applications/${echoAppId}/api-keys`, { name: 'echo' })).json()
        .key;
    }, 60_000);

    afterAll(async () => {
      app?.server.closeAllConnections();
      await app?.close();
      for (const m of mocks) await m.close();
      await drop?.();
    });

    beforeEach(async () => {
      for (const m of mocks) {
        m.failWith = null;
        m.responseDelayMs = 0;
        m.seenAuth = [];
      }
      cooldowns.clear();
      await db.query("UPDATE provider_accounts SET health_status = 'healthy'");
      await db.query('DELETE FROM routing_policies');
      await db.query('DELETE FROM route_scores');
      await observations.flush();
      await db.query('DELETE FROM route_observations');
      candidates.invalidate();
    });

    describe('bounded fallback', () => {
      it('falls back to the same model on another key when the first key fails', async () => {
        const plan = await explain('llama-cpp/mock-chat');
        const first = plan.fallbackOrder[0].accountId as string;
        const second = plan.fallbackOrder[1].accountId as string;
        mockByAccount.get(first)!.failWith = 503;

        const res = await chat({ model: 'llama-cpp/mock-chat' });
        expect(res.statusCode).toBe(200);
        expect(res.headers['x-arc-route-account']).toBe(second);
        expect(res.headers['x-arc-route-attempts']).toBe('2');
        expect(res.headers['x-arc-fallback']).toBe('provider_error');
        expect(calls(ids.C)).toBe(0);
      });

      it('skips a rate-limited key on later requests instead of calling it again', async () => {
        const first = (await explain('llama-cpp/mock-chat')).fallbackOrder[0].accountId as string;
        mockByAccount.get(first)!.failWith = 429;
        expect((await chat({ model: 'llama-cpp/mock-chat' })).statusCode).toBe(200);
        expect(calls(first)).toBe(1);

        mockByAccount.get(first)!.failWith = null;
        const next = await chat({ model: 'llama-cpp/mock-chat' });
        expect(next.statusCode).toBe(200);
        expect(next.headers['x-arc-route-attempts']).toBe('1');
        expect(calls(first)).toBe(1); // still cooling down: not called again
      });

      it('does not fall back when the provider rejects the request itself (4xx)', async () => {
        const [first, second] = (await explain('llama-cpp/mock-chat')).fallbackOrder.map(
          (p: { accountId: string }) => p.accountId,
        );
        mockByAccount.get(first)!.failWith = 400;
        const res = await chat({ model: 'llama-cpp/mock-chat' });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('provider_rejected_request');
        expect(calls(second)).toBe(0);
      });

      it('"auto" falls back across models once the first model has no working key', async () => {
        const plan = (await explain('auto')).fallbackOrder as Array<{
          accountId: string;
          model: string;
        }>;
        expect(plan).toHaveLength(3);
        // Keys of the best model come first, before a different model (models stay contiguous).
        const models = plan.map((p) => p.model);
        const firstModelKeys = models.filter((m) => m === models[0]).length;
        expect(models.slice(0, firstModelKeys).every((m) => m === models[0])).toBe(true);
        expect(new Set(models.slice(firstModelKeys)).has(models[0]!)).toBe(false);
        mockByAccount.get(plan[0]!.accountId)!.failWith = 503;
        mockByAccount.get(plan[1]!.accountId)!.failWith = 503;
        const res = await chat();
        expect(res.statusCode).toBe(200);
        expect(res.headers['x-arc-route-account']).toBe(plan[2]!.accountId);
        expect(res.headers['x-arc-route-attempts']).toBe('3');
      });

      it('an explicit model never silently switches to a different model', async () => {
        mockByAccount.get(ids.A)!.failWith = 503;
        mockByAccount.get(ids.B)!.failWith = 503;
        const res = await chat({ model: 'llama-cpp/mock-chat' });
        expect(res.statusCode).toBe(502);
        expect(res.headers['x-arc-fallback']).toBe('provider_error,provider_error');
        expect(calls(ids.C)).toBe(0);
      });

      it('stops at the attempt limit', async () => {
        for (const m of mocks) m.failWith = 503;
        const res = await chat();
        expect(res.statusCode).toBe(502);
        expect(mocks.reduce((n, m) => n + m.seenAuth.length, 0)).toBe(3);
      });

      it('never falls back past the request deadline', async () => {
        const [first, second] = (await explain('llama-cpp/mock-chat')).fallbackOrder.map(
          (p: { accountId: string }) => p.accountId,
        );
        mockByAccount.get(first)!.responseDelayMs = 1500;
        const started = Date.now();
        const res = await chat({ model: 'llama-cpp/mock-chat' }, { 'x-arc-deadline-ms': '400' });
        expect(res.statusCode).toBe(504);
        expect(Date.now() - started).toBeLessThan(1200);
        expect(calls(second)).toBe(0);
      });
    });

    describe('policy gates', () => {
      it('per-app jurisdiction policy excludes CN providers everywhere, including fallback', async () => {
        const put = await admin(ownerCookie)('PUT', `/applications/${echoAppId}/routing-policy`, {
          allowedJurisdictions: ['SELF_HOSTED'],
        });
        expect(put.statusCode).toBe(200);

        const models = await app.inject({
          method: 'GET',
          url: '/v1/models',
          headers: { authorization: `Bearer ${arcKey}` },
        });
        expect(models.json().data.map((m: { id: string }) => m.id)).not.toContain(
          'siliconflow/mock-chat',
        );

        mockByAccount.get(ids.A)!.failWith = 503;
        mockByAccount.get(ids.B)!.failWith = 503;
        expect((await chat()).statusCode).toBe(502);
        expect(calls(ids.C)).toBe(0);

        const why = await explain('auto', echoAppId);
        expect(why.rejected.rejected_jurisdiction).toBeGreaterThan(0);

        await admin(ownerCookie)('DELETE', `/applications/${echoAppId}/routing-policy`);
        expect((await chat({ model: 'siliconflow/mock-chat' })).statusCode).toBe(200);
      });

      it('paid models on owner keys need explicit approval by the platform owner', async () => {
        const call = admin(ownerCookie);
        await call('PATCH', `/models/${modelIds['siliconflow/mock-chat']}`, {
          eligibility: 'PAID',
          eligibilityEvidenceUrl: 'https://example.test/pricing',
        });
        expect((await chat({ model: 'siliconflow/mock-chat' })).statusCode).toBe(503);

        const denied = await admin(customerCookie)('PUT', '/routing/policy', {
          allowedJurisdictions: null,
          allowPaidOwnerKeys: true,
        });
        expect(denied.statusCode).toBe(403);

        expect(
          (
            await call('PUT', '/routing/policy', {
              allowedJurisdictions: null,
              allowPaidOwnerKeys: true,
            })
          ).statusCode,
        ).toBe(200);
        expect((await chat({ model: 'siliconflow/mock-chat' })).statusCode).toBe(200);

        await call('PATCH', `/models/${modelIds['siliconflow/mock-chat']}`, {
          eligibility: 'VERIFIED_FREE',
          eligibilityEvidenceUrl: 'https://example.test/terms',
          enabled: true,
        });
      });

      it('explains routes on request', async () => {
        const res = await chat({}, { 'x-arc-explain': 'true' });
        const why = JSON.parse(res.headers['x-arc-route-explain'] as string);
        expect(why.candidates.length).toBeGreaterThan(0);
        expect(why.candidates[0].v).toBe('selected');
      });
    });

    describe('performance ranking (worker-computed, off the request path)', () => {
      it('learns that one key is faster and routes to it', async () => {
        mockByAccount.get(ids.A)!.responseDelayMs = 150;
        // Send traffic to each key in turn (cooldown the other), so both get measured.
        for (const [busy, idle] of [
          [ids.A, ids.B],
          [ids.B, ids.A],
        ] as const) {
          cooldowns.clear();
          cooldowns.rateLimited(idle, 60);
          for (let i = 0; i < 6; i++) {
            const r = await chat({ model: 'llama-cpp/mock-chat' });
            expect(r.headers['x-arc-route-account']).toBe(busy);
          }
        }
        cooldowns.clear();
        await observations.flush();
        const { rows } = await db.query('SELECT sum(requests)::int AS n FROM route_observations');
        expect(rows[0].n).toBe(12);
        // Timing must be real (regression: a logger-dependent clock once recorded 0 ms).
        const slow = await db.query(
          'SELECT ttfb_ms_sum / ttfb_samples AS avg FROM route_observations WHERE account_id = $1',
          [ids.A],
        );
        expect(slow.rows[0].avg).toBeGreaterThanOrEqual(140);

        expect(await computeRouteScores(db)).toBe(2);
        candidates.invalidate();
        const plan = await explain('llama-cpp/mock-chat');
        expect(plan.selected.accountId).toBe(ids.B);
        const res = await chat({ model: 'llama-cpp/mock-chat' });
        expect(res.headers['x-arc-route-account']).toBe(ids.B);
      });

      it('a worker stuck holding the scores table cannot block inference', async () => {
        const blocker = new pg.Client({
          connectionString: (db as unknown as { options: { connectionString: string } }).options
            .connectionString,
        });
        await blocker.connect();
        await blocker.query('BEGIN');
        await blocker.query('LOCK TABLE route_scores IN ACCESS EXCLUSIVE MODE');
        try {
          candidates.invalidate();
          const started = Date.now();
          const res = await chat();
          expect(res.statusCode).toBe(200);
          expect(Date.now() - started).toBeLessThan(1000);
        } finally {
          await blocker.query('ROLLBACK');
          await blocker.end();
        }
      });
    });

    describe('background key health checks', () => {
      it('re-validates stale keys and records their health', async () => {
        await db.query(
          "UPDATE provider_accounts SET health_status = 'unknown', last_validated_at = now() - interval '1 day' WHERE id = $1",
          [ids.A],
        );
        const n = await revalidateStaleAccounts(db, credentials, new HttpProviderProbe(), {
          staleMinutes: 15,
          invalidRecheckMinutes: 360,
          batchSize: 10,
          probeTimeoutMs: 2000,
        });
        expect(n).toBe(1);
        const { rows } = await db.query(
          "SELECT health_status, last_validated_at > now() - interval '1 minute' AS fresh FROM provider_accounts WHERE id = $1",
          [ids.A],
        );
        expect(rows[0]).toEqual({ health_status: 'healthy', fresh: true });
      });

      it('applies the SSRF guard to customer keys before probing them', async () => {
        const created = await admin(customerCookie)('POST', '/provider-accounts', {
          providerId: 'groq',
          label: 'byok',
          apiKey: 'gsk_customer_key_000000',
          baseUrl: 'https://byok.example.test/v1',
        });
        expect(created.statusCode).toBe(201);
        await db.query(
          "UPDATE provider_accounts SET last_validated_at = now() - interval '1 day' WHERE id = $1",
          [created.json().id],
        );
        await db.query('UPDATE provider_accounts SET last_validated_at = now() WHERE id <> $1', [
          created.json().id,
        ]);
        let probed = 0;
        const n = await revalidateStaleAccounts(
          db,
          credentials,
          { probe: async () => (probed++, { status: 'healthy', models: [] }) },
          {
            staleMinutes: 15,
            invalidRecheckMinutes: 360,
            batchSize: 10,
            probeTimeoutMs: 2000,
            urlGuard: async () => {
              throw new Error('resolves to a private address now');
            },
          },
        );
        expect(n).toBe(1);
        expect(probed).toBe(0);
        const { rows } = await db.query(
          'SELECT health_status FROM provider_accounts WHERE id = $1',
          [created.json().id],
        );
        expect(rows[0].health_status).toBe('unsupported');
      });
    });
  },
);
