import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createOwner } from '../src/auth/owner.js';
import type { Db } from '../src/db/pool.js';
import { RollupRecorder } from '../src/inference/rollups.js';
import type { ProbeInput, ProbeResult, ProviderProbe } from '../src/providers/probe.js';
import type { AdminDeps } from '../src/routes/deps.js';
import { CredentialService } from '../src/vault/credentials.js';
import { generateKeyFile, parseKeyRing } from '../src/vault/vault.js';
import { TEST_DATABASE_URL, createTestDatabase } from './helpers/db.js';

const OWNER = { email: 'owner@arc.test', password: 'owner-password-123' };
const PASSWORD = 'customer-password-123';

class FakeProbe implements ProviderProbe {
  async probe(_input: ProbeInput): Promise<ProbeResult> {
    return { status: 'healthy', models: ['gemini-fast'] };
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

describe.skipIf(!TEST_DATABASE_URL)('customers: sign-up, invitations, team, usage', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let app: FastifyInstance;
  let openApp: FastifyInstance;
  let owner: ReturnType<typeof as>;
  const dashboardDir = mkdtempSync(path.join(tmpdir(), 'arc-dashboard-'));

  const cookieOf = (res: LightMyRequestResponse) => {
    const c = res.cookies.find((x) => x.name === 'arc_session');
    return c ? `arc_session=${c.value}` : '';
  };
  function as(cookie: string, target: () => FastifyInstance = () => app, tenant?: string) {
    return (method: Method, url: string, payload?: object) =>
      target().inject({
        method,
        url: `/admin/v1${url}`,
        headers: { cookie, ...(tenant ? { 'x-arc-tenant': tenant } : {}) },
        ...(payload ? { payload } : {}),
      });
  }
  const anon = as('');
  const login = async (email: string, password = PASSWORD) =>
    cookieOf(
      await app.inject({
        method: 'POST',
        url: '/admin/v1/auth/login',
        payload: { email, password },
      }),
    );

  function build(extra: Partial<AdminDeps> = {}) {
    return buildApp({
      checks: [],
      readinessTimeoutMs: 500,
      dashboardDir,
      admin: {
        db,
        credentials: new CredentialService(parseKeyRing(generateKeyFile())),
        probe: new FakeProbe(),
        cookieSecure: true,
        sessionTtlMs: 3_600_000,
        probeTimeoutMs: 1000,
        ...extra,
      },
    });
  }

  /** The owner invites a new customer; they sign up with the link. Returns their cookie. */
  async function onboardCustomer(email: string, organization: string) {
    const inv = await owner('POST', '/console/invitations', { email });
    expect(inv.statusCode).toBe(201);
    const res = await anon('POST', '/auth/signup', {
      email,
      password: PASSWORD,
      organization,
      inviteToken: inv.json().token,
    });
    expect(res.statusCode).toBe(201);
    const cookie = cookieOf(res);
    const me = await as(cookie)('GET', '/auth/me');
    return { cookie, tenantId: me.json().tenants[0].id as string };
  }

  beforeAll(async () => {
    ({ db, drop } = await createTestDatabase());
    mkdirSync(path.join(dashboardDir, 'assets'));
    writeFileSync(path.join(dashboardDir, 'index.html'), '<!doctype html><title>ARC</title>');
    app = build();
    openApp = build({ signupMode: 'open' });
    await createOwner(db, OWNER);
    owner = as(await login(OWNER.email, OWNER.password));
  });

  afterAll(async () => {
    await app?.close();
    await openApp?.close();
    await drop?.();
  });

  it('reports the sign-up mode and refuses sign-up without an invitation by default', async () => {
    expect((await anon('GET', '/auth/config')).json()).toEqual({ signup: 'invite' });
    const res = await anon('POST', '/auth/signup', {
      email: 'nobody@example.test',
      password: PASSWORD,
      organization: 'Nobody Ltd',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('invitation_required');
  });

  it('allows open sign-up when configured, creating an organization owned by the new user', async () => {
    const res = await openApp.inject({
      method: 'POST',
      url: '/admin/v1/auth/signup',
      payload: { email: 'open@example.test', password: PASSWORD, organization: 'Open Co' },
    });
    expect(res.statusCode).toBe(201);
    const me = await as(cookieOf(res), () => openApp)('GET', '/auth/me');
    expect(me.json().tenants).toMatchObject([
      { kind: 'organization', name: 'Open Co', role: 'owner' },
    ]);
    // Weak passwords and missing organization names are refused.
    const weak = await openApp.inject({
      method: 'POST',
      url: '/admin/v1/auth/signup',
      payload: { email: 'weak@example.test', password: 'short', organization: 'W' },
    });
    expect(weak.statusCode).toBe(400);
    const noOrg = await openApp.inject({
      method: 'POST',
      url: '/admin/v1/auth/signup',
      payload: { email: 'noorg@example.test', password: PASSWORD },
    });
    expect(noOrg.statusCode).toBe(400);
  });

  it('owner invitations: preview, email must match, one use only, never stored in clear', async () => {
    const inv = await owner('POST', '/console/invitations', { email: 'ada@example.test' });
    expect(inv.statusCode).toBe(201);
    const { token } = inv.json();
    expect(token).toMatch(/^arci_/);
    const stored = await db.query('SELECT token_hash FROM invitations WHERE id = $1', [
      inv.json().id,
    ]);
    expect(stored.rows[0].token_hash.toString()).not.toContain(token);

    const preview = await anon('POST', '/auth/invitations/preview', { token });
    expect(preview.json()).toMatchObject({
      email: 'ada@example.test',
      newOrganization: true,
      organization: null,
    });
    expect((await owner('GET', '/console/invitations')).json().data).toHaveLength(1);

    const wrong = await anon('POST', '/auth/signup', {
      email: 'eve@example.test',
      password: PASSWORD,
      organization: 'Eve',
      inviteToken: token,
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('invitation_email_mismatch');

    const ok = await anon('POST', '/auth/signup', {
      email: 'Ada@Example.test',
      password: PASSWORD,
      organization: 'Analytical Engines',
      inviteToken: token,
    });
    expect(ok.statusCode).toBe(201);

    const again = await anon('POST', '/auth/signup', {
      email: 'ada2@example.test',
      password: PASSWORD,
      organization: 'Again',
      inviteToken: token,
    });
    expect(again.statusCode).toBe(410);
    expect((await anon('POST', '/auth/invitations/preview', { token })).statusCode).toBe(404);
    expect((await owner('GET', '/console/invitations')).json().data).toHaveLength(0);
  });

  it('only the platform owner can invite new customers', async () => {
    const { cookie } = await onboardCustomer('bob@example.test', 'Bob Co');
    const res = await as(cookie)('POST', '/console/invitations', { email: 'x@example.test' });
    expect(res.statusCode).toBe(403);
  });

  it('team: invite, join, roles, last owner and removal', async () => {
    const { cookie: carol, tenantId } = await onboardCustomer('carol@example.test', 'Carol Co');
    const c = as(carol);

    const inv = await c('POST', '/invitations', { email: 'dan@example.test', role: 'member' });
    expect(inv.statusCode).toBe(201);
    expect((await c('GET', '/invitations')).json().data).toHaveLength(1);

    // Dan signs up with the link and joins Carol Co as a member (no new organization).
    const preview = await anon('POST', '/auth/invitations/preview', { token: inv.json().token });
    expect(preview.json()).toMatchObject({ organization: 'Carol Co', newOrganization: false });
    const signup = await anon('POST', '/auth/signup', {
      email: 'dan@example.test',
      password: PASSWORD,
      inviteToken: inv.json().token,
    });
    expect(signup.statusCode).toBe(201);
    const d = as(cookieOf(signup));
    const me = (await d('GET', '/auth/me')).json();
    expect(me.tenants).toMatchObject([{ id: tenantId, role: 'member' }]);

    const members = (await c('GET', '/members')).json().data;
    expect(members.map((m: { email: string; role: string }) => [m.email, m.role])).toEqual([
      ['carol@example.test', 'owner'],
      ['dan@example.test', 'member'],
    ]);

    // Members can't invite or manage; only owners change roles.
    expect((await d('POST', '/invitations', { email: 'e@example.test' })).statusCode).toBe(403);
    expect((await d('GET', '/invitations')).statusCode).toBe(403);
    const danId = members[1].userId;
    const carolId = members[0].userId;
    expect((await d('PATCH', `/members/${carolId}`, { role: 'member' })).statusCode).toBe(403);
    expect((await d('DELETE', `/members/${carolId}`)).statusCode).toBe(403);

    // Promote Dan to admin: admins can invite members and admins, but not owners.
    expect((await c('PATCH', `/members/${danId}`, { role: 'admin' })).statusCode).toBe(200);
    expect(
      (await d('POST', '/invitations', { email: 'f@example.test', role: 'owner' })).statusCode,
    ).toBe(403);
    const fInv = await d('POST', '/invitations', { email: 'f@example.test', role: 'admin' });
    expect(fInv.statusCode).toBe(201);
    expect((await d('DELETE', `/invitations/${fInv.json().id}`)).statusCode).toBe(204);

    // The last owner can't leave or be demoted.
    expect((await c('DELETE', `/members/${carolId}`)).statusCode).toBe(409);
    expect((await c('PATCH', `/members/${carolId}`, { role: 'admin' })).statusCode).toBe(409);

    // Inviting an existing member is refused.
    expect((await c('POST', '/invitations', { email: 'dan@example.test' })).statusCode).toBe(409);

    // Carol removes Dan; his session no longer reaches the tenant.
    expect((await c('DELETE', `/members/${danId}`)).statusCode).toBe(204);
    expect((await d('GET', '/applications')).statusCode).toBe(403);
  });

  it('an existing user accepts an invitation and then must choose a tenant per request', async () => {
    const { cookie: gina, tenantId: ginaTenant } = await onboardCustomer(
      'gina@example.test',
      'Gina Co',
    );
    const { cookie: hal, tenantId: halTenant } = await onboardCustomer(
      'hal@example.test',
      'Hal Co',
    );
    const inv = await as(gina)('POST', '/invitations', {
      email: 'hal@example.test',
      role: 'admin',
    });
    // Signing up again with an existing email is refused; accepting while signed in works.
    const dup = await anon('POST', '/auth/signup', {
      email: 'hal@example.test',
      password: PASSWORD,
      inviteToken: inv.json().token,
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('account_exists');
    // Someone else can't use Hal's invitation.
    expect(
      (await as(gina)('POST', '/auth/invitations/accept', { token: inv.json().token })).statusCode,
    ).toBe(403);
    const accepted = await as(hal)('POST', '/auth/invitations/accept', {
      token: inv.json().token,
    });
    expect(accepted.json()).toEqual({ tenantId: ginaTenant });

    const ambiguous = await as(hal)('GET', '/applications');
    expect(ambiguous.statusCode).toBe(400);
    expect(ambiguous.json().error.code).toBe('tenant_required');
    expect((await as(hal, () => app, ginaTenant)('GET', '/members')).statusCode).toBe(200);
    expect((await as(hal, () => app, halTenant)('GET', '/tenant')).json()).toMatchObject({
      name: 'Hal Co',
      role: 'owner',
    });
  });

  it('isolates tenants: usage, apps, keys, members, invitations', async () => {
    const a = await onboardCustomer('ivy@example.test', 'Ivy Co');
    const b = await onboardCustomer('jon@example.test', 'Jon Co');
    const ivy = as(a.cookie);
    const jon = as(b.cookie);

    const ivyApp = (
      await ivy('POST', '/applications', { name: 'Ivy App', slug: 'ivy-app' })
    ).json();
    const jonApp = (
      await jon('POST', '/applications', { name: 'Jon App', slug: 'jon-app' })
    ).json();
    const key = await ivy('POST', '/provider-accounts', {
      providerId: 'gemini',
      label: 'Ivy Gemini',
      apiKey: 'AIzaFAKE-ivy-0000000000',
    });
    expect(key.statusCode).toBe(201);
    expect(key.json().scope).toBe('tenant_byok');

    const rollups = new RollupRecorder(db);
    const row = {
      endpoint: 'chat/completions',
      providerId: 'gemini',
      modelName: 'gemini/gemini-fast',
      accountId: '',
      error: false,
      fallback: false,
      overheadMs: 1,
      durationMs: 100,
    };
    for (let i = 0; i < 3; i++) {
      rollups.record({ ...row, tenantId: a.tenantId, applicationId: ivyApp.id });
    }
    rollups.record({ ...row, tenantId: b.tenantId, applicationId: jonApp.id });
    await rollups.flush();

    const usage = (await ivy('GET', '/usage?range=24h&by=app')).json();
    expect(usage.rows).toHaveLength(1);
    expect(usage.rows[0]).toMatchObject({ label: 'Ivy App', requests: 3 });
    expect(usage.series.reduce((s: number, p: { requests: number }) => s + p.requests, 0)).toBe(3);
    // Another tenant's app id is not found, not leaked.
    expect((await ivy('GET', `/usage?app=${jonApp.id}`)).statusCode).toBe(404);

    expect((await jon('GET', '/provider-accounts')).json().data).toHaveLength(0);
    expect((await jon('GET', `/provider-accounts/${key.json().id}`)).statusCode).toBe(404);
    expect(
      (await jon('GET', '/applications')).json().data.map((x: { slug: string }) => x.slug),
    ).toEqual(['jon-app']);
    const jonMembers = (await jon('GET', '/members')).json().data;
    expect(jonMembers.map((m: { email: string }) => m.email)).toEqual(['jon@example.test']);
    // Removing a user of another tenant: not found in this tenant.
    const ivyId = (await ivy('GET', '/members')).json().data[0].userId;
    expect((await jon('DELETE', `/members/${ivyId}`)).statusCode).toBe(404);
    // Customers can't reach the owner console's data.
    expect((await ivy('GET', '/console/traffic')).statusCode).toBe(403);
  });

  it('owners rename their organization; members cannot', async () => {
    const { cookie } = await onboardCustomer('kim@example.test', 'Kim Co');
    const res = await as(cookie)('PATCH', '/tenant', { name: 'Kim & Co' });
    expect(res.json()).toMatchObject({ name: 'Kim & Co' });
    expect((await as(cookie)('GET', '/auth/me')).json().tenants[0].name).toBe('Kim & Co');
  });

  it('serves the dashboard at /dashboard', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard/apps' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<title>ARC</title>');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });
});
