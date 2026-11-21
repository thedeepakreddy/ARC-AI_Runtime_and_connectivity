import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createOwner } from '../src/auth/owner.js';
import { hashPassword } from '../src/auth/password.js';
import { migrate } from '../src/db/migrate.js';
import type { Db } from '../src/db/pool.js';
import type { ProbeInput, ProbeResult, ProviderProbe } from '../src/providers/probe.js';
import { assertPublicHttpsUrl } from '../src/providers/url-guard.js';
import { CredentialService } from '../src/vault/credentials.js';
import { generateKeyFile, parseKeyRing } from '../src/vault/vault.js';
import { TEST_DATABASE_URL, createTestDatabase } from './helpers/db.js';

const OWNER = { email: 'owner@arc.test', password: 'owner-password-123' };
const CUSTOMER = { email: 'customer@example.test', password: 'customer-password-123' };
const GEMINI_KEY_1 = 'AIzaFAKEKEY-number-one-0001';
const GEMINI_KEY_2 = 'AIzaFAKEKEY-number-two-0002';
const GEMINI_KEY_3 = 'AIzaFAKEKEY-number-three-03';

class FakeProbe implements ProviderProbe {
  calls: ProbeInput[] = [];
  next: ProbeResult = { status: 'healthy', models: ['gemini-fast', 'gemini-pro'] };
  async probe(input: ProbeInput): Promise<ProbeResult> {
    this.calls.push(input);
    return this.next;
  }
}

describe.skipIf(!TEST_DATABASE_URL)('control plane (PostgreSQL)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let app: FastifyInstance;
  let credentials: CredentialService;
  const probe = new FakeProbe();
  let ownerCookie: string;
  let customerCookie: string;
  let platformTenantId: string;

  async function login(email: string, password: string): Promise<LightMyRequestResponse> {
    return app.inject({
      method: 'POST',
      url: '/admin/v1/auth/login',
      payload: { email, password },
    });
  }

  function cookieOf(res: LightMyRequestResponse): string {
    const c = res.cookies.find((x) => x.name === 'arc_session');
    if (!c) throw new Error('no session cookie');
    return `arc_session=${c.value}`;
  }

  const as =
    (cookie: string) =>
    (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
      app.inject({
        method,
        url: `/admin/v1${url}`,
        headers: { cookie },
        ...(payload ? { payload } : {}),
      });

  beforeAll(async () => {
    ({ db, drop } = await createTestDatabase());
    credentials = new CredentialService(parseKeyRing(generateKeyFile()));
    app = buildApp({
      checks: [],
      readinessTimeoutMs: 100,
      admin: {
        db,
        credentials,
        probe,
        cookieSecure: true,
        sessionTtlMs: 3_600_000,
        probeTimeoutMs: 1000,
        // Deterministic DNS for tests: *.internal.test resolves to a private address.
        assertPublicUrl: (url) =>
          assertPublicHttpsUrl(url, async (host) => [
            host.endsWith('.internal.test') ? '10.0.0.7' : '8.8.8.8',
          ]),
      },
    });
    ({ tenantId: platformTenantId } = await createOwner(db, OWNER));

    // A separate customer tenant (signup arrives in a later phase; seed it directly).
    const t = await db.query<{ id: string }>(
      "INSERT INTO tenants (kind, name) VALUES ('organization', 'Customer Co') RETURNING id",
    );
    const u = await db.query<{ id: string }>(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
      [CUSTOMER.email, await hashPassword(CUSTOMER.password)],
    );
    await db.query("INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')", [
      t.rows[0]!.id,
      u.rows[0]!.id,
    ]);

    ownerCookie = cookieOf(await login(OWNER.email, OWNER.password));
    customerCookie = cookieOf(await login(CUSTOMER.email, CUSTOMER.password));
  });

  afterAll(async () => {
    await app?.close();
    await drop?.();
  });

  describe('migrations and bootstrap', () => {
    it('re-running migrations is a no-op', async () => {
      expect(await migrate(db)).toEqual([]);
    });

    it('refuses to create a second platform owner', async () => {
      await expect(
        createOwner(db, { email: 'other@arc.test', password: 'another-password-1' }),
      ).rejects.toThrow(/already exists/);
    });

    it('seeds the full provider catalogue, including Chinese providers', async () => {
      const res = await as(ownerCookie)('GET', '/providers');
      const ids = res.json().data.map((p: { id: string }) => p.id);
      expect(ids).toEqual(
        expect.arrayContaining(['gemini', 'groq', 'alibaba-dashscope', 'deepseek', 'siliconflow']),
      );
      const qwen = res.json().data.find((p: { id: string }) => p.id === 'alibaba-dashscope');
      expect(qwen.jurisdiction).toBe('CN');
      expect(qwen.verifiedAt).toBeNull();
    });
  });

  describe('authentication', () => {
    it('rejects a wrong password with a generic message', async () => {
      const res = await login(OWNER.email, 'not-the-password');
      expect(res.statusCode).toBe(401);
      expect(res.json().error.message).toBe('Email or password is incorrect');
    });

    it('sets a secure, httpOnly, SameSite=Strict session cookie', async () => {
      const res = await login(OWNER.email, OWNER.password);
      const c = res.cookies.find((x) => x.name === 'arc_session')!;
      expect(c.httpOnly).toBe(true);
      expect(c.secure).toBe(true);
      expect(c.sameSite).toBe('Strict');
    });

    it('requires a session for admin routes', async () => {
      const res = await app.inject({ method: 'GET', url: '/admin/v1/provider-accounts' });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.type).toBe('authentication_error');
    });

    it('reports the signed-in user and logout revokes the session', async () => {
      const cookie = cookieOf(await login(OWNER.email, OWNER.password));
      const me = await as(cookie)('GET', '/auth/me');
      expect(me.json().user).toMatchObject({ email: OWNER.email, isSuperadmin: true });
      expect((await as(cookie)('POST', '/auth/logout')).statusCode).toBe(200);
      expect((await as(cookie)('GET', '/auth/me')).statusCode).toBe(401);
    });
  });

  describe('multiple keys per provider', () => {
    const ids: string[] = [];

    it('registers several keys for the same provider', async () => {
      for (const [label, apiKey] of [
        ['Gemini A', GEMINI_KEY_1],
        ['Gemini B', GEMINI_KEY_2],
        ['Gemini C', GEMINI_KEY_3],
      ] as const) {
        const res = await as(ownerCookie)('POST', '/provider-accounts', {
          providerId: 'gemini',
          label,
          apiKey,
        });
        expect(res.statusCode).toBe(201);
        expect(res.json()).toMatchObject({
          providerId: 'gemini',
          label,
          scope: 'owner_private',
          enabled: true,
        });
        ids.push(res.json().id);
      }
      const list = await as(ownerCookie)('GET', '/provider-accounts?provider=gemini');
      expect(list.json().data).toHaveLength(3);
    });

    it('never returns keys, only a short hint', async () => {
      const list = await as(ownerCookie)('GET', '/provider-accounts');
      const text = list.body;
      for (const k of [GEMINI_KEY_1, GEMINI_KEY_2, GEMINI_KEY_3]) expect(text).not.toContain(k);
      expect(list.json().data[0].secretHint).toMatch(/^\*\*\*\*.{4}$/);
    });

    it('stores keys encrypted at rest', async () => {
      const { rows } = await db.query<{ ciphertext: Buffer; wrapped_dek: Buffer }>(
        'SELECT ciphertext, wrapped_dek FROM credentials',
      );
      for (const r of rows) {
        expect(r.ciphertext.toString('latin1')).not.toContain('AIzaFAKEKEY');
        expect(r.wrapped_dek.length).toBeGreaterThan(32);
      }
    });

    it('rejects a duplicate label for the same provider', async () => {
      const res = await as(ownerCookie)('POST', '/provider-accounts', {
        providerId: 'gemini',
        label: 'Gemini A',
        apiKey: 'AIzaANOTHER-key-000000',
      });
      expect(res.statusCode).toBe(409);
    });

    it('disables and renames a single key independently', async () => {
      const res = await as(ownerCookie)('PATCH', `/provider-accounts/${ids[1]}`, {
        enabled: false,
        label: 'Gemini B (paused)',
      });
      expect(res.json()).toMatchObject({ enabled: false, label: 'Gemini B (paused)' });
      const other = await as(ownerCookie)('GET', `/provider-accounts/${ids[0]}`);
      expect(other.json().enabled).toBe(true);
    });

    it('validates a key with its own secret and discovers models as UNKNOWN + disabled', async () => {
      probe.calls = [];
      const res = await as(ownerCookie)('POST', `/provider-accounts/${ids[2]}/validate`);
      expect(res.json()).toMatchObject({ status: 'healthy', modelsSeen: 2 });
      expect(probe.calls[0]!.apiKey).toBe(GEMINI_KEY_3);
      expect(JSON.stringify(res.json())).not.toContain(GEMINI_KEY_3);

      const acct = await as(ownerCookie)('GET', `/provider-accounts/${ids[2]}`);
      expect(acct.json().healthStatus).toBe('healthy');

      const models = await as(ownerCookie)('GET', '/models?provider=gemini');
      expect(models.json().data).toHaveLength(2);
      for (const m of models.json().data)
        expect(m).toMatchObject({ eligibility: 'UNKNOWN', enabled: false });
    });

    it('records an invalid key without failing the request', async () => {
      probe.next = { status: 'invalid_credentials', models: [], error: 'provider responded 401' };
      const res = await as(ownerCookie)('POST', `/provider-accounts/${ids[0]}/validate`);
      expect(res.json().status).toBe('invalid_credentials');
      probe.next = { status: 'healthy', models: ['gemini-fast', 'gemini-pro'] };
    });

    it('replaces a key and deletes the old encrypted credential', async () => {
      const before = await db.query('SELECT count(*)::int AS n FROM credentials');
      const res = await as(ownerCookie)('PUT', `/provider-accounts/${ids[0]}/credential`, {
        apiKey: 'AIzaREPLACEMENT-key-9999',
      });
      expect(res.json()).toMatchObject({ healthStatus: 'unknown', secretHint: '****9999' });
      const after = await db.query('SELECT count(*)::int AS n FROM credentials');
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });

    it('deletes a key and its credential', async () => {
      const res = await as(ownerCookie)('DELETE', `/provider-accounts/${ids[1]}`);
      expect(res.statusCode).toBe(204);
      const list = await as(ownerCookie)('GET', '/provider-accounts?provider=gemini');
      expect(list.json().data).toHaveLength(2);
      const creds = await db.query('SELECT count(*)::int AS n FROM credentials');
      expect(creds.rows[0].n).toBe(2);
    });

    it('audits key changes without secrets', async () => {
      const res = await as(ownerCookie)('GET', '/audit-events?limit=200');
      const actions = res.json().data.map((e: { action: string }) => e.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          'provider_account.created',
          'provider_account.validated',
          'provider_account.deleted',
        ]),
      );
      expect(res.body).not.toContain('AIzaFAKEKEY');
    });
  });

  describe('model eligibility', () => {
    let modelId: string;

    beforeAll(async () => {
      const res = await as(ownerCookie)('GET', '/models?provider=gemini');
      modelId = res.json().data[0].id;
    });

    it('cannot enable a model while eligibility is UNKNOWN', async () => {
      const res = await as(ownerCookie)('PATCH', `/models/${modelId}`, { enabled: true });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('eligibility_unknown');
    });

    it('requires evidence to classify a model', async () => {
      const res = await as(ownerCookie)('PATCH', `/models/${modelId}`, {
        eligibility: 'VERIFIED_FREE',
      });
      expect(res.json().error.code).toBe('evidence_required');
    });

    it('classifies with evidence, then enables', async () => {
      const res = await as(ownerCookie)('PATCH', `/models/${modelId}`, {
        eligibility: 'VERIFIED_FREE',
        eligibilityEvidenceUrl: 'https://ai.google.dev/pricing',
        capabilities: ['text', 'streaming'],
        enabled: true,
      });
      expect(res.json()).toMatchObject({ eligibility: 'VERIFIED_FREE', enabled: true });
      expect(res.json().eligibilityCheckedAt).not.toBeNull();
    });

    it('resetting to UNKNOWN disables the model and clears evidence', async () => {
      const res = await as(ownerCookie)('PATCH', `/models/${modelId}`, { eligibility: 'UNKNOWN' });
      expect(res.json()).toMatchObject({
        eligibility: 'UNKNOWN',
        enabled: false,
        eligibilityEvidenceUrl: null,
      });
    });

    it("classifies OpenRouter models automatically; the owner's choice is never overwritten", async () => {
      const call = as(ownerCookie);
      const created = await call('POST', '/provider-accounts', {
        providerId: 'openrouter',
        label: 'Router',
        apiKey: 'sk-or-v1-fake-key-0000000000',
      });
      const accountId = created.json().id;
      probe.next = {
        status: 'healthy',
        models: ['meta/llama:free', 'openai/gpt-x'],
        hints: {
          'meta/llama:free': {
            pricing: { prompt: '0', completion: '0' },
            inputModalities: ['text', 'image'],
            supportedParameters: ['tools'],
          },
          'openai/gpt-x': { pricing: { prompt: '0.000002', completion: '0.00001' } },
        },
      };
      await call('POST', `/provider-accounts/${accountId}/validate`);
      const list = (await call('GET', '/models?provider=openrouter')).json().data as Array<{
        id: string;
        modelId: string;
        eligibility: string;
        enabled: boolean;
        classifiedBy: string;
        capabilities: string[];
      }>;
      const free = list.find((m) => m.modelId === 'meta/llama:free')!;
      const paid = list.find((m) => m.modelId === 'openai/gpt-x')!;
      expect(free).toMatchObject({
        eligibility: 'VERIFIED_FREE',
        enabled: true,
        classifiedBy: 'auto',
      });
      expect(free.capabilities).toEqual(expect.arrayContaining(['text', 'vision', 'tools']));
      expect(paid).toMatchObject({ eligibility: 'PAID', enabled: false, classifiedBy: 'auto' });

      // The owner switches the free model off; validating again keeps it off.
      await call('PATCH', `/models/${free.id}`, { enabled: false });
      await call('POST', `/provider-accounts/${accountId}/validate`);
      const again = (await call('GET', '/models?provider=openrouter')).json().data;
      expect(again.find((m: { id: string }) => m.id === free.id)).toMatchObject({
        enabled: false,
        classifiedBy: 'owner',
      });

      // "Use automatic" brings the suggestion back.
      const back = await call('PATCH', `/models/${free.id}`, { useSuggestion: true });
      expect(back.json()).toMatchObject({
        eligibility: 'VERIFIED_FREE',
        enabled: true,
        classifiedBy: 'auto',
      });
      probe.next = { status: 'healthy', models: ['gemini-fast', 'gemini-pro'] };
    });

    it('only the platform superadmin can change the catalogue', async () => {
      const res = await as(customerCookie)('PATCH', `/models/${modelId}`, {
        capabilities: ['text'],
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('tenant isolation', () => {
    let ownerAccountId: string;
    let customerAccountId: string;

    beforeAll(async () => {
      const list = await as(ownerCookie)('GET', '/provider-accounts');
      ownerAccountId = list.json().data[0].id;
      const created = await as(customerCookie)('POST', '/provider-accounts', {
        providerId: 'gemini',
        label: 'Gemini A',
        apiKey: 'AIzaCUSTOMER-own-key-42',
      });
      expect(created.statusCode).toBe(201);
      customerAccountId = created.json().id;
    });

    it('customer keys are BYOK-scoped; same label is allowed in another tenant', async () => {
      const res = await as(customerCookie)('GET', `/provider-accounts/${customerAccountId}`);
      expect(res.json().scope).toBe('tenant_byok');
    });

    it("a customer cannot see or touch the owner's keys", async () => {
      const call = as(customerCookie);
      const list = await call('GET', '/provider-accounts');
      expect(list.json().data.map((a: { id: string }) => a.id)).toEqual([customerAccountId]);
      expect((await call('GET', `/provider-accounts/${ownerAccountId}`)).statusCode).toBe(404);
      expect(
        (await call('PATCH', `/provider-accounts/${ownerAccountId}`, { enabled: false }))
          .statusCode,
      ).toBe(404);
      expect((await call('POST', `/provider-accounts/${ownerAccountId}/validate`)).statusCode).toBe(
        404,
      );
      expect(
        (
          await call('PUT', `/provider-accounts/${ownerAccountId}/credential`, {
            apiKey: 'AIzaHIJACK-key-000',
          })
        ).statusCode,
      ).toBe(404);
      expect((await call('DELETE', `/provider-accounts/${ownerAccountId}`)).statusCode).toBe(404);
    });

    it('customers cannot point a key at internal addresses (SSRF)', async () => {
      const call = as(customerCookie);
      for (const baseUrl of [
        'https://db.internal.test/v1',
        'https://127.0.0.1/v1',
        'http://api.example.test/v1',
      ]) {
        const res = await call('POST', '/provider-accounts', {
          providerId: 'groq',
          label: `ssrf ${baseUrl}`,
          apiKey: 'gsk_customer_key_000000',
          baseUrl,
        });
        expect(res.statusCode).toBe(400);
      }
      const patch = await call('PATCH', `/provider-accounts/${customerAccountId}`, {
        baseUrl: 'https://169.254.169.254/latest',
      });
      expect(patch.statusCode).toBe(400);
      const ok = await call('PATCH', `/provider-accounts/${customerAccountId}`, {
        baseUrl: 'https://api.example.test/v1',
      });
      expect(ok.statusCode).toBe(200);
    });

    it('the platform owner may use local hosts (e.g. Ollama)', async () => {
      const res = await as(ownerCookie)('POST', '/provider-accounts', {
        providerId: 'ollama',
        label: 'Local Ollama',
        apiKey: 'ollama-local-placeholder',
        baseUrl: 'http://127.0.0.1:11434/v1',
      });
      expect(res.statusCode).toBe(201);
    });

    it("the owner cannot see a customer's keys either", async () => {
      const list = await as(ownerCookie)('GET', '/provider-accounts');
      expect(list.json().data.map((a: { id: string }) => a.id)).not.toContain(customerAccountId);
    });

    it('a credential cannot be decrypted under another tenant', async () => {
      const { rows } = await db.query<{ credential_id: string }>(
        'SELECT credential_id FROM provider_accounts WHERE id = $1',
        [customerAccountId],
      );
      await expect(
        credentials.reveal(db, platformTenantId, rows[0]!.credential_id),
      ).rejects.toThrow(/not found/);
    });

    it('cannot act on a tenant the user is not a member of', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/v1/provider-accounts',
        headers: { cookie: customerCookie, 'x-arc-tenant': platformTenantId },
      });
      expect(res.statusCode).toBe(403);
    });

    it('audit logs are tenant-scoped', async () => {
      const res = await as(customerCookie)('GET', '/audit-events?limit=200');
      for (const e of res.json().data) expect(e.targetId).not.toBe(ownerAccountId);
    });
  });

  describe('applications', () => {
    it('registers first-party apps in the platform tenant', async () => {
      for (const [name, slug] of [
        ['Echo', 'echo'],
        ['Aira', 'aira'],
        ['Data Science Studio', 'data-science-studio'],
      ]) {
        const res = await as(ownerCookie)('POST', '/applications', {
          name,
          slug,
          firstParty: true,
        });
        expect(res.statusCode).toBe(201);
      }
      const list = await as(ownerCookie)('GET', '/applications');
      expect(list.json().data).toHaveLength(3);
    });

    it('customers cannot register first-party apps', async () => {
      const res = await as(customerCookie)('POST', '/applications', {
        name: 'X',
        slug: 'x-app',
        firstParty: true,
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
