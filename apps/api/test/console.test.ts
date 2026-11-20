import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createOwner } from '../src/auth/owner.js';
import { hashPassword } from '../src/auth/password.js';
import type { Db } from '../src/db/pool.js';
import { RollupRecorder } from '../src/inference/rollups.js';
import { ApiKeyVerifier } from '../src/keys/verifier.js';
import type { ProbeInput, ProbeResult, ProviderProbe } from '../src/providers/probe.js';
import { CredentialService } from '../src/vault/credentials.js';
import { generateKeyFile, parseKeyRing } from '../src/vault/vault.js';
import { pruneObservations } from '../src/worker/jobs.js';
import { TEST_DATABASE_URL, createTestDatabase } from './helpers/db.js';

const OWNER = { email: 'owner@arc.test', password: 'owner-password-123' };
const CUSTOMER = { email: 'customer@example.test', password: 'customer-password-123' };

class FakeProbe implements ProviderProbe {
  next: ProbeResult = { status: 'healthy', models: ['gemini-fast', 'gemini-pro'] };
  async probe(_input: ProbeInput): Promise<ProbeResult> {
    return this.next;
  }
}

describe.skipIf(!TEST_DATABASE_URL)('console API (PostgreSQL)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let app: FastifyInstance;
  let ownerCookie: string;
  let customerCookie: string;
  let customerTenantId: string;
  let echoAppId: string;
  let platformTenantId: string;
  const revoked: string[] = [];
  const consoleDir = mkdtempSync(path.join(tmpdir(), 'arc-console-'));

  const login = (email: string, password: string, ua = 'test') =>
    app.inject({
      method: 'POST',
      url: '/admin/v1/auth/login',
      headers: { 'user-agent': ua },
      payload: { email, password },
    });
  const cookieOf = (res: LightMyRequestResponse) =>
    `arc_session=${res.cookies.find((c) => c.name === 'arc_session')!.value}`;
  const as =
    (cookie: string) =>
    (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
      app.inject({
        method,
        url: `/admin/v1${url}`,
        headers: { cookie },
        ...(payload ? { payload } : {}),
      });

  beforeAll(async () => {
    ({ db, drop } = await createTestDatabase());
    mkdirSync(path.join(consoleDir, 'assets'));
    writeFileSync(path.join(consoleDir, 'index.html'), '<!doctype html><title>ARC Console</title>');
    writeFileSync(path.join(consoleDir, 'assets', 'app-1a2b.js'), 'console.log(1)');
    app = buildApp({
      checks: [{ name: 'postgres', check: async () => undefined }],
      readinessTimeoutMs: 500,
      consoleDir,
      admin: {
        db,
        credentials: new CredentialService(parseKeyRing(generateKeyFile())),
        probe: new FakeProbe(),
        cookieSecure: true,
        sessionTtlMs: 3_600_000,
        probeTimeoutMs: 1000,
        readiness: async () => ({
          ready: true,
          dependencies: [{ name: 'postgres', status: 'up', latencyMs: 1 }],
        }),
        onApiKeyRevoked: (keyId) => revoked.push(keyId),
      },
    });
    ({ tenantId: platformTenantId } = await createOwner(db, OWNER));
    const t = await db.query<{ id: string }>(
      "INSERT INTO tenants (kind, name) VALUES ('organization', 'Customer Co') RETURNING id",
    );
    customerTenantId = t.rows[0]!.id;
    const u = await db.query<{ id: string }>(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
      [CUSTOMER.email, await hashPassword(CUSTOMER.password)],
    );
    await db.query("INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')", [
      customerTenantId,
      u.rows[0]!.id,
    ]);
    ownerCookie = cookieOf(await login(OWNER.email, OWNER.password, 'Safari on Mac'));
    customerCookie = cookieOf(await login(CUSTOMER.email, CUSTOMER.password));

    const owner = as(ownerCookie);
    echoAppId = (
      await owner('POST', '/applications', {
        name: 'Echo Phone',
        slug: 'echo-phone',
        firstParty: true,
      })
    ).json().id;
    // Two Gemini keys; one later fails. Discovered models arrive UNKNOWN (to classify).
    for (const label of ['Gemini 1', 'Gemini 2']) {
      const r = await owner('POST', '/provider-accounts', {
        providerId: 'gemini',
        label,
        apiKey: `AIzaFAKE-${label}-000000`,
      });
      expect(r.statusCode).toBe(201);
      await owner('POST', `/provider-accounts/${r.json().id}/validate`);
    }
    await db.query(
      "UPDATE provider_accounts SET health_status = 'invalid_credentials', last_validation_error = 'API key not valid' WHERE label = 'Gemini 2'",
    );

    // Traffic: 3 requests for Echo, one an error with a fallback.
    const rollups = new RollupRecorder(db);
    const base = {
      tenantId: platformTenantId,
      applicationId: echoAppId,
      endpoint: 'chat/completions',
      modelName: 'gemini/gemini-fast',
      accountId: '',
    };
    rollups.record({
      ...base,
      providerId: 'gemini',
      error: false,
      fallback: false,
      overheadMs: 2,
      durationMs: 300,
    });
    rollups.record({
      ...base,
      providerId: 'gemini',
      error: false,
      fallback: true,
      overheadMs: 4,
      durationMs: 500,
    });
    rollups.record({
      ...base,
      providerId: '',
      modelName: '',
      error: true,
      fallback: false,
      overheadMs: null,
      durationMs: 10,
    });
    await rollups.flush();
  });

  afterAll(async () => {
    await app?.close();
    await drop?.();
  });

  it('is for the platform owner only', async () => {
    expect((await as(customerCookie)('GET', '/console/overview')).statusCode).toBe(403);
    expect((await as(customerCookie)('GET', '/console/customers')).statusCode).toBe(403);
    expect(
      (await app.inject({ method: 'GET', url: '/admin/v1/console/overview' })).statusCode,
    ).toBe(401);
  });

  it('overview: services, what needs the owner, totals, series and breakdowns', async () => {
    const r = await as(ownerCookie)('GET', '/console/overview?range=24h');
    expect(r.statusCode).toBe(200);
    const o = r.json();
    expect(o.services.map((s: { name: string }) => s.name)).toEqual(['API', 'Postgres', 'Worker']);
    expect(o.services.find((s: { name: string }) => s.name === 'Worker').status).toBe('down'); // no heartbeat yet
    expect(o.allUp).toBe(false);
    const kinds = o.needsYou.map((n: { kind: string }) => n.kind);
    expect(kinds[0]).toBe('key_failing'); // critical first
    expect(o.needsYou[0].title).toContain('Gemini 2');
    expect(o.needsYou[0].href).toMatch(/^\/providers\?key=/);
    expect(kinds).toContain('models_to_classify');
    expect(o.totals).toEqual({
      requests: 3,
      errorRate: 1 / 3,
      fallbackRate: 1 / 3,
      overheadMsAvg: 3,
    });
    expect(o.series).toHaveLength(24);
    expect(o.series.reduce((s: number, p: { requests: number }) => s + p.requests, 0)).toBe(3);
    expect(o.byApp).toEqual([{ id: echoAppId, name: 'Echo Phone', requests: 3, errorRate: 1 / 3 }]);
    expect(o.byProvider).toEqual([{ provider: 'Google Gemini', requests: 2, share: 1 }]);
  });

  it('traffic: grouped by app, provider, model; failures without a route are labelled', async () => {
    const owner = as(ownerCookie);
    const byModel = (await owner('GET', '/console/traffic?range=7d&by=model')).json();
    expect(byModel.series).toHaveLength(7);
    expect(byModel.rows.map((r: { label: string }) => r.label).sort()).toEqual([
      'No route',
      'gemini/gemini-fast',
    ]);
    const byProvider = (await owner('GET', '/console/traffic?by=provider')).json();
    const gemini = byProvider.rows.find((r: { label: string }) => r.label === 'Google Gemini');
    expect(gemini).toMatchObject({
      requests: 2,
      errorRate: 0,
      fallbackRate: 0.5,
      overheadMsAvg: 3,
      durationMsAvg: 400,
    });
    expect((await owner('GET', '/console/traffic?by=nope')).statusCode).toBe(400);
    const forEcho = (await owner('GET', `/console/traffic?by=model&app=${echoAppId}`)).json();
    expect(forEcho.rows.reduce((t: number, r: { requests: number }) => t + r.requests, 0)).toBe(3);
    const forNobody = (
      await owner('GET', '/console/traffic?by=model&app=00000000-0000-4000-8000-000000000000')
    ).json();
    expect(forNobody.rows).toEqual([]);
    expect(forNobody.series.every((p: { requests: number }) => p.requests === 0)).toBe(true);
  });

  it('models keep a terms note', async () => {
    const owner = as(ownerCookie);
    const model = (await owner('GET', '/models?provider=gemini')).json().data[0];
    const r = await owner('PATCH', `/models/${model.id}`, {
      eligibility: 'RESTRICTED_FREE',
      eligibilityEvidenceUrl: 'https://ai.google.dev/pricing',
      termsNote: '  1,000 requests/day per project  ',
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().termsNote).toBe('1,000 requests/day per project');
    expect(
      (await owner('PATCH', `/models/${model.id}`, { termsNote: null })).json().termsNote,
    ).toBeNull();
    expect(
      (await owner('PATCH', `/models/${model.id}`, { termsNote: 'x'.repeat(501) })).statusCode,
    ).toBe(400);
  });

  it('rotation can keep the old key working for an overlap', async () => {
    const owner = as(ownerCookie);
    const first = (
      await owner('POST', `/applications/${echoAppId}/api-keys`, { name: 'echo prod' })
    ).json();
    const rotated = await owner('POST', `/api-keys/${first.id}/rotate`, { overlapMinutes: 60 });
    expect(rotated.statusCode).toBe(201);
    const verifier = new ApiKeyVerifier(db);
    expect(await verifier.verify(first.key)).not.toBeNull(); // still works during the overlap
    expect(await verifier.verify(rotated.json().key)).not.toBeNull();
    const old = await db.query<{ expires_at: Date; revoked_at: Date | null }>(
      'SELECT expires_at, revoked_at FROM api_keys WHERE id = $1',
      [first.id],
    );
    expect(old.rows[0]!.revoked_at).toBeNull();
    const minutes = (old.rows[0]!.expires_at.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(58);
    expect(minutes).toBeLessThanOrEqual(60);
    // Without an overlap, the old key stops at once (as before).
    const again = await owner('POST', `/api-keys/${rotated.json().id}/rotate`, {});
    expect(again.statusCode).toBe(201);
    expect(await new ApiKeyVerifier(db).verify(rotated.json().key)).toBeNull();
    expect(
      (await owner('POST', `/api-keys/${again.json().id}/rotate`, { overlapMinutes: 5 }))
        .statusCode,
    ).toBe(400);
  });

  it('customers: listed with counts, suspended and restored at once', async () => {
    const owner = as(ownerCookie);
    const app2 = await db.query<{ id: string }>(
      "INSERT INTO applications (tenant_id, name, slug) VALUES ($1, 'Their app', 'their-app') RETURNING id",
      [customerTenantId],
    );
    const key = (
      await as(customerCookie)('POST', `/applications/${app2.rows[0]!.id}/api-keys`, { name: 'k' })
    ).json();
    const list = (await owner('GET', '/console/customers')).json().data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Customer Co', members: 1, apps: 1, suspendedAt: null });

    revoked.length = 0;
    expect((await owner('POST', `/console/customers/${customerTenantId}/suspend`)).statusCode).toBe(
      204,
    );
    expect(revoked).toContain(
      key.keyId ??
        (await db.query('SELECT key_id FROM api_keys WHERE id = $1', [key.id])).rows[0].key_id,
    );
    expect(await new ApiKeyVerifier(db).verify(key.key)).toBeNull();
    expect((await as(customerCookie)('GET', '/applications')).statusCode).toBe(403);
    expect(
      (await owner('POST', `/console/customers/${customerTenantId}/unsuspend`)).statusCode,
    ).toBe(204);
    expect(await new ApiKeyVerifier(db).verify(key.key)).not.toBeNull();
    expect((await owner('POST', `/console/customers/${platformTenantId}/suspend`)).statusCode).toBe(
      404,
    );
    const audit = (await owner('GET', '/audit-events'))
      .json()
      .data.map((e: { action: string }) => e.action);
    expect(audit).not.toContain('tenant.suspended'); // recorded in the customer's tenant, not the owner's
  });

  it('account: sessions are listed and revocable; a password change signs out other sessions', async () => {
    const second = cookieOf(await login(OWNER.email, OWNER.password, 'Chrome on iPhone'));
    const sessions = (await as(ownerCookie)('GET', '/account/sessions')).json().data;
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(sessions.map((s: { userAgent: string }) => s.userAgent)).toContain('Chrome on iPhone');

    expect(
      (
        await as(ownerCookie)('POST', '/account/password', {
          currentPassword: 'wrong-password-1',
          newPassword: 'another-password-456',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await as(ownerCookie)('POST', '/account/password', {
          currentPassword: OWNER.password,
          newPassword: 'short',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await as(ownerCookie)('POST', '/account/password', {
          currentPassword: OWNER.password,
          newPassword: 'another-password-456',
        })
      ).statusCode,
    ).toBe(204);
    expect((await as(second)('GET', '/auth/me')).statusCode).toBe(401);
    expect((await as(ownerCookie)('GET', '/auth/me')).statusCode).toBe(200);
    expect((await login(OWNER.email, 'another-password-456')).statusCode).toBe(200);

    const other = cookieOf(await login(OWNER.email, 'another-password-456', 'Firefox'));
    const otherId = (await as(other)('GET', '/account/sessions'))
      .json()
      .data.find((s: { current: boolean }) => s.current).id;
    expect((await as(ownerCookie)('DELETE', `/account/sessions/${otherId}`)).statusCode).toBe(204);
    expect((await as(other)('GET', '/auth/me')).statusCode).toBe(401);
  });

  it('serves the console with a strict content-security policy and browser routing', async () => {
    const index = await app.inject({ method: 'GET', url: '/console/models' });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain('ARC Console');
    expect(index.headers['content-security-policy']).toContain("default-src 'self'");
    expect(index.headers['cache-control']).toBe('no-cache');
    const asset = await app.inject({ method: 'GET', url: '/console/assets/app-1a2b.js' });
    expect(asset.headers['content-type']).toContain('text/javascript');
    expect(asset.headers['cache-control']).toContain('immutable');
    // Paths outside the console directory are refused, never read.
    const escape = await app.inject({ method: 'GET', url: '/console/..%2f..%2fetc%2fpasswd' });
    expect(escape.statusCode).toBe(404);
    expect(escape.body).not.toContain('root:');
    expect((await app.inject({ method: 'GET', url: '/console' })).statusCode).toBe(302);
  });

  it('old traffic is pruned after 30 days', async () => {
    await db.query("UPDATE request_rollups SET bucket = now() - interval '31 days'");
    await pruneObservations(db);
    expect((await db.query('SELECT count(*)::int AS n FROM request_rollups')).rows[0].n).toBe(0);
  });
});
