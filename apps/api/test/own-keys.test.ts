import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { CredentialService } from '../src/vault/credentials.js';
import { generateKeyFile, parseKeyRing } from '../src/vault/vault.js';
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
        stream: false,
      }),
      signal: input.signal,
    });
  }
}

const OWNER = { email: 'owner@arc.test', password: 'owner-password-123' };
const CUSTOMER = { email: 'cust@example.test', password: 'customer-password-123' };
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

describe.skipIf(!TEST_DATABASE_URL)(
  'own keys: customers choose models; end users bring keys',
  () => {
    let db: Db;
    let drop: () => Promise<void>;
    let app: FastifyInstance;
    let mock: MockProvider;
    let candidates: CandidateStore;
    let owner: (m: Method, url: string, body?: object) => Promise<LightMyRequestResponse>;
    let customer: typeof owner;
    let echoKey: string;
    let custKey: string;
    const models: Record<string, string> = {};

    const admin = (cookie: string) => (method: Method, url: string, payload?: object) =>
      app.inject({
        method,
        url: `/admin/v1${url}`,
        headers: { cookie },
        ...(payload ? { payload } : {}),
      });
    const v1 =
      (key: string) =>
      (method: Method, url: string, payload?: object, headers: Record<string, string> = {}) =>
        app.inject({
          method,
          url: `/v1${url}`,
          headers: { authorization: `Bearer ${key}`, ...headers },
          ...(payload ? { payload } : {}),
        });
    const chat = (key: string, headers: Record<string, string> = {}, model = 'auto') =>
      v1(key)(
        'POST',
        '/chat/completions',
        { model, messages: [{ role: 'user', content: 'hi' }] },
        headers,
      );
    const embed = (key: string) =>
      v1(key)('POST', '/embeddings', { model: 'mockcloud/mock-embed', input: 'hi' });
    /** The provider key the mock saw on its last request. */
    const lastKey = () => mock.seenAuth.at(-1);

    beforeAll(async () => {
      ({ db, drop } = await createTestDatabase());
      mock = await startMockProvider();
      // A cloud provider (default address) for the tests, pointing at the mock.
      await db.query(
        `INSERT INTO providers (id, display_name, provider_group, jurisdiction, adapter, default_base_url)
       VALUES ('mockcloud', 'Mock Cloud', 'core', 'US', 'openai_compatible', $1)`,
        [mock.url],
      );
      const credentials = new CredentialService(parseKeyRing(generateKeyFile()));
      const verifier = new ApiKeyVerifier(db);
      candidates = new CandidateStore(db);
      const probe = new HttpProviderProbe();
      app = buildApp({
        checks: [],
        readinessTimeoutMs: 100,
        admin: {
          db,
          credentials,
          probe,
          cookieSecure: false,
          sessionTtlMs: 3_600_000,
          probeTimeoutMs: 2000,
          onRoutingChange: () => candidates.invalidate(),
        },
        inference: {
          db,
          credentials,
          verifier,
          candidates,
          cooldowns: new Cooldowns(),
          observations: new ObservationRecorder(db, 3_600_000),
          gateway: new DirectGateway(),
          defaultDeadlineMs: 10_000,
          maxDeadlineMs: 20_000,
          bodyLimitBytes: 1024 * 1024,
          requestsPerMinute: 10_000,
          maxAttempts: 3,
          minAttemptMs: 100,
          userKeys: { probe, probeTimeoutMs: 2000, onChange: () => candidates.invalidate() },
        },
      });

      const login = async (email: string, password: string) => {
        const r = await app.inject({
          method: 'POST',
          url: '/admin/v1/auth/login',
          payload: { email, password },
        });
        return `arc_session=${r.cookies.find((c) => c.name === 'arc_session')!.value}`;
      };
      await createOwner(db, OWNER);
      owner = admin(await login(OWNER.email, OWNER.password));

      // The owner's key; the owner classifies mock-chat (free, on) and leaves mock-embed UNKNOWN.
      const k = await owner('POST', '/provider-accounts', {
        providerId: 'mockcloud',
        label: 'Owner',
        apiKey: 'owner-key-0000',
      });
      expect(
        (await owner('POST', `/provider-accounts/${k.json().id}/validate`)).json().status,
      ).toBe('healthy');
      for (const m of (await owner('GET', '/models?provider=mockcloud')).json().data as Array<{
        id: string;
        modelId: string;
      }>) {
        models[m.modelId] = m.id;
        const isEmbed = m.modelId === 'mock-embed';
        await owner('PATCH', `/models/${m.id}`, {
          capabilities: isEmbed ? ['embeddings'] : ['text', 'streaming'],
          ...(isEmbed
            ? {}
            : {
                eligibility: 'VERIFIED_FREE',
                eligibilityEvidenceUrl: 'https://example.test/terms',
                enabled: true,
              }),
        });
      }
      const echo = (
        await owner('POST', '/applications', { name: 'Echo', slug: 'echo', firstParty: true })
      ).json();
      echoKey = (await owner('POST', `/applications/${echo.id}/api-keys`, { name: 'e' })).json()
        .key;

      // A customer with their own key and app.
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
      customer = admin(await login(CUSTOMER.email, CUSTOMER.password));
      const ck = await customer('POST', '/provider-accounts', {
        providerId: 'mockcloud',
        label: 'Mine',
        apiKey: 'customer-key-0000',
      });
      await customer('POST', `/provider-accounts/${ck.json().id}/validate`);
      const capp = (await customer('POST', '/applications', { name: 'C', slug: 'c-app' })).json();
      custKey = (await customer('POST', `/applications/${capp.id}/api-keys`, { name: 'c' })).json()
        .key;
    }, 60_000);

    afterAll(async () => {
      app?.server.closeAllConnections();
      await app?.close();
      await mock?.close();
      await drop?.();
    });

    describe('customers decide which models their own keys use', () => {
      it('lists the models their keys see, following the owner until they choose', async () => {
        const list = (await customer('GET', '/tenant/models')).json().data as Array<{
          modelId: string;
          enabled: boolean;
          choice: boolean | null;
          eligibility: string;
        }>;
        expect(list.find((m) => m.modelId === 'mock-chat')).toMatchObject({
          enabled: true,
          choice: null,
        });
        expect(list.find((m) => m.modelId === 'mock-embed')).toMatchObject({
          enabled: false,
          eligibility: 'UNKNOWN',
        });
        expect((await chat(custKey)).statusCode).toBe(200);
        expect(lastKey()).toBe('Bearer customer-key-0000');
        expect((await owner('GET', '/tenant/models')).statusCode).toBe(403);
      });

      it('turning a model off affects only that customer', async () => {
        await customer('PUT', `/tenant/models/${models['mock-chat']}`, { enabled: false });
        expect((await chat(custKey)).statusCode).not.toBe(200);
        expect((await chat(echoKey)).statusCode).toBe(200);
        expect(lastKey()).toBe('Bearer owner-key-0000');
        await customer('PUT', `/tenant/models/${models['mock-chat']}`, { enabled: null });
        expect((await chat(custKey)).statusCode).toBe(200);
      });

      it('a customer may use a model ARC hasn’t classified, on their own key only', async () => {
        expect((await embed(custKey)).statusCode).not.toBe(200);
        await customer('PUT', `/tenant/models/${models['mock-embed']}`, { enabled: true });
        const res = await embed(custKey);
        expect(res.statusCode).toBe(200);
        expect(lastKey()).toBe('Bearer customer-key-0000');
        // Still unknown, so never on the owner's keys.
        expect((await embed(echoKey)).statusCode).not.toBe(200);
      });

      it('only for models their keys see', async () => {
        const r = await customer('PUT', '/tenant/models/00000000-0000-4000-8000-000000000000', {
          enabled: true,
        });
        expect(r.statusCode).toBe(404);
      });
    });

    describe('end users bring their own keys through the app (X-ARC-User)', () => {
      const as = (user: string) => ({ 'x-arc-user': user });

      it('stores a user’s key, checks it, and never returns it', async () => {
        const put = await v1(echoKey)(
          'PUT',
          '/user-keys/mockcloud',
          { apiKey: 'alice-key-0000' },
          as('user-1001'),
        );
        expect(put.statusCode).toBe(200);
        expect(put.json()).toMatchObject({ provider: 'mockcloud', health: 'healthy' });
        expect(JSON.stringify(put.json())).not.toContain('alice-key-0000');
        const list = (await v1(echoKey)('GET', '/user-keys', undefined, as('user-1001'))).json();
        expect(list.data).toEqual([expect.objectContaining({ provider: 'mockcloud' })]);
        // The user id is not stored, only a hash; the owner's key list doesn't show user keys.
        const rows = await db.query(
          "SELECT end_user_hash, label FROM provider_accounts WHERE scope = 'end_user'",
        );
        expect(JSON.stringify(rows.rows)).not.toContain('user-1001');
        const ownerList = (await owner('GET', '/provider-accounts')).json().data;
        expect(ownerList.every((a: { label: string }) => !a.label.startsWith('end user'))).toBe(
          true,
        );
      });

      it('routes that user’s requests to their key only; everyone else uses the app’s keys', async () => {
        const mine = await chat(echoKey, as('user-1001'));
        expect(mine.statusCode).toBe(200);
        expect(lastKey()).toBe('Bearer alice-key-0000');
        expect(mine.headers['x-arc-user-keys']).toBe('own');

        const other = await chat(echoKey, as('user-2002'));
        expect(lastKey()).toBe('Bearer owner-key-0000');
        expect(other.headers['x-arc-user-keys']).toBe('app');

        await chat(echoKey);
        expect(lastKey()).toBe('Bearer owner-key-0000');
      });

      it('is scoped to the app: the same user id in another app has no key there', async () => {
        await chat(custKey, as('user-1001'));
        expect(lastKey()).toBe('Bearer customer-key-0000');
      });

      it('replaces and deletes keys', async () => {
        await v1(echoKey)(
          'PUT',
          '/user-keys/mockcloud',
          { apiKey: 'alice-key-1111' },
          as('user-1001'),
        );
        await chat(echoKey, as('user-1001'));
        expect(lastKey()).toBe('Bearer alice-key-1111');
        expect(
          (await v1(echoKey)('DELETE', '/user-keys/mockcloud', undefined, as('user-1001')))
            .statusCode,
        ).toBe(204);
        await chat(echoKey, as('user-1001'));
        expect(lastKey()).toBe('Bearer owner-key-0000');
        expect(
          (await v1(echoKey)('DELETE', '/user-keys/mockcloud', undefined, as('user-1001')))
            .statusCode,
        ).toBe(404);
      });

      it('validates the header and needs it for /v1/user-keys', async () => {
        expect((await chat(echoKey, as('bad id with spaces'))).statusCode).toBe(400);
        expect((await v1(echoKey)('GET', '/user-keys')).statusCode).toBe(400);
        expect(
          (await v1(echoKey)('PUT', '/user-keys/nope', { apiKey: 'x-key-00000' }, as('u1')))
            .statusCode,
        ).toBe(404);
      });
    });
  },
);
