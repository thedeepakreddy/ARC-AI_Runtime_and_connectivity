import { createHash } from 'node:crypto';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createOwner } from '../src/auth/owner.js';
import { base32Decode, base32Encode, matchTotp, totpAt } from '../src/auth/totp.js';
import type { Db } from '../src/db/pool.js';
import type { Mailer } from '../src/mail/mailer.js';
import type { ProbeInput, ProbeResult, ProviderProbe } from '../src/providers/probe.js';
import type { AdminDeps } from '../src/routes/deps.js';
import { CredentialService } from '../src/vault/credentials.js';
import { generateKeyFile, parseKeyRing } from '../src/vault/vault.js';
import { TEST_DATABASE_URL, createTestDatabase } from './helpers/db.js';

describe('TOTP (RFC 6238)', () => {
  it('matches the RFC test vector and round-trips base32', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(totpAt(secret, 1)).toBe('287082'); // T = 59 s → 94287082, last 6 digits
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
  });
  it('accepts the current step and one either side, nothing else', () => {
    const s = base32Encode(Buffer.from('abcdefghijklmnopqrst'));
    const now = 1_800_000_000_000;
    const step = Math.floor(now / 30_000);
    expect(matchTotp(s, totpAt(s, step), now)).toBe(step);
    expect(matchTotp(s, totpAt(s, step - 1), now)).toBe(step - 1);
    expect(matchTotp(s, totpAt(s, step + 2), now)).toBeNull();
    expect(matchTotp(s, 'abcdef', now)).toBeNull();
  });
});

class FakeMailer implements Mailer {
  sent: { to: string; subject: string; text: string }[] = [];
  async send(m: { to: string; subject: string; text: string }) {
    this.sent.push(m);
  }
  /** The token in the last link sent to `to`. */
  tokenFor(to: string): string {
    const m = [...this.sent].reverse().find((x) => x.to === to);
    const t = m?.text.match(/#(arc[a-z]_[A-Za-z0-9_-]+)/)?.[1];
    if (!t) throw new Error(`no link for ${to}`);
    return t;
  }
}

class NoProbe implements ProviderProbe {
  async probe(_i: ProbeInput): Promise<ProbeResult> {
    return { status: 'healthy', models: [] };
  }
}

/** Google's token and userinfo endpoints, enough for the authorization-code + PKCE flow. */
async function startFakeGoogle() {
  const state = {
    profile: { sub: 'g-1', email: 'g@example.test', email_verified: true },
    challenge: '',
    lastVerifier: '',
  };
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.url === '/token') {
        const p = new URLSearchParams(raw);
        state.lastVerifier = p.get('code_verifier') ?? '';
        const ok =
          p.get('code') === 'good-code' &&
          createHash('sha256').update(state.lastVerifier).digest('base64url') === state.challenge;
        res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(ok ? { access_token: 'at' } : { error: 'invalid_grant' }));
      }
      if (req.url === '/userinfo') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(state.profile));
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, state, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const PUBLIC = 'https://arc.example.test';
const OWNER = { email: 'owner@arc.test', password: 'owner-password-123' };
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

describe.skipIf(!TEST_DATABASE_URL)('account security (PostgreSQL)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let app: FastifyInstance;
  let openApp: FastifyInstance;
  let credentials: CredentialService;
  let google: Awaited<ReturnType<typeof startFakeGoogle>>;
  const mailer = new FakeMailer();

  const cookieOf = (res: LightMyRequestResponse) => {
    const c = res.cookies.find((x) => x.name === 'arc_session');
    return c ? `arc_session=${c.value}` : '';
  };
  const call =
    (cookie = '', target: () => FastifyInstance = () => app) =>
    (method: Method, url: string, payload?: object) =>
      target().inject({
        method,
        url: `/admin/v1${url}`,
        headers: cookie ? { cookie } : {},
        ...(payload ? { payload } : {}),
      });
  const anon = call();
  const login = (email: string, password: string) =>
    anon('POST', '/auth/login', { email, password });
  const nowCode = (secret: string) => totpAt(secret, Math.floor(Date.now() / 30_000));
  const nextCode = (secret: string) => totpAt(secret, Math.floor(Date.now() / 30_000) + 1);

  function build(extra: Partial<AdminDeps>) {
    return buildApp({
      checks: [],
      readinessTimeoutMs: 100,
      admin: {
        db,
        credentials,
        probe: new NoProbe(),
        cookieSecure: true,
        sessionTtlMs: 3_600_000,
        probeTimeoutMs: 1000,
        mailer,
        publicUrl: PUBLIC,
        google: {
          clientId: 'client-1',
          clientSecret: 'secret-1',
          authUrl: 'https://accounts.example.test/auth',
          tokenUrl: `${google.url}/token`,
          userinfoUrl: `${google.url}/userinfo`,
        },
        ...extra,
      },
    });
  }

  beforeAll(async () => {
    ({ db, drop } = await createTestDatabase());
    credentials = new CredentialService(parseKeyRing(generateKeyFile()));
    google = await startFakeGoogle();
    app = build({});
    openApp = build({ signupMode: 'open' });
    await createOwner(db, OWNER);
  });

  afterAll(async () => {
    await app?.close();
    await openApp?.close();
    await google?.close();
    await drop?.();
  });

  it('advertises what this ARC supports', async () => {
    expect((await anon('GET', '/auth/config')).json()).toEqual({
      signup: 'invite',
      passwordReset: true,
      google: true,
    });
  });

  describe('two-step sign-in', () => {
    let secret = '';
    let enableCode = '';
    let recovery: string[] = [];

    it('sets up with a confirmed code and hands out recovery codes once', async () => {
      const owner = call(cookieOf(await login(OWNER.email, OWNER.password)));
      const setup = (await owner('POST', '/account/mfa/setup')).json();
      secret = setup.secret;
      expect(setup.otpauthUrl).toMatch(/^otpauth:\/\/totp\/ARC%3Aowner%40arc\.test\?secret=/);
      expect((await owner('POST', '/account/mfa/enable', { code: '000000' })).statusCode).toBe(400);
      enableCode = nowCode(secret);
      const on = await owner('POST', '/account/mfa/enable', { code: enableCode });
      expect(on.statusCode).toBe(200);
      recovery = on.json().recoveryCodes;
      expect(recovery).toHaveLength(10);
      expect((await owner('GET', '/account/security')).json()).toMatchObject({
        mfaEnabled: true,
        recoveryCodesLeft: 10,
      });
      // The secret is sealed with the vault key, never stored in clear.
      const row = await db.query("SELECT mfa_ciphertext FROM users WHERE email = 'owner@arc.test'");
      expect(row.rows[0].mfa_ciphertext.toString()).not.toContain(secret);
    });

    it('a password alone no longer signs in; the second step does, once per code', async () => {
      const first = await login(OWNER.email, OWNER.password);
      expect(first.json()).toMatchObject({ mfaRequired: true });
      expect(cookieOf(first)).toBe('');
      const { mfaToken } = first.json();
      expect((await anon('POST', '/auth/login/mfa', { mfaToken, code: '123456' })).statusCode).toBe(
        401,
      );
      // The enable step used the current code: replaying it is refused; the next one works.
      expect(
        (await anon('POST', '/auth/login/mfa', { mfaToken, code: enableCode })).statusCode,
      ).toBe(401);
      const ok = await anon('POST', '/auth/login/mfa', { mfaToken, code: nextCode(secret) });
      expect(ok.statusCode).toBe(200);
      expect(cookieOf(ok)).not.toBe('');
      // The challenge is spent.
      expect(
        (await anon('POST', '/auth/login/mfa', { mfaToken, code: nextCode(secret) })).statusCode,
      ).toBe(401);
    });

    it('recovery codes work once each', async () => {
      const { mfaToken } = (await login(OWNER.email, OWNER.password)).json();
      const ok = await anon('POST', '/auth/login/mfa', {
        mfaToken,
        code: recovery[0]!.toUpperCase(),
      });
      expect(ok.statusCode).toBe(200);
      const again = (await login(OWNER.email, OWNER.password)).json();
      expect(
        (await anon('POST', '/auth/login/mfa', { mfaToken: again.mfaToken, code: recovery[0]! }))
          .statusCode,
      ).toBe(401);
    });

    it('stops a challenge after 5 wrong codes', async () => {
      const { mfaToken } = (await login(OWNER.email, OWNER.password)).json();
      for (let i = 0; i < 5; i++) {
        await anon('POST', '/auth/login/mfa', { mfaToken, code: '000000' });
      }
      expect(
        (await anon('POST', '/auth/login/mfa', { mfaToken, code: recovery[1]! })).statusCode,
      ).toBe(429);
    });

    it('survives a vault key rotation', async () => {
      const original = (credentials as unknown as { ring: Parameters<typeof generateKeyFile>[0] })
        .ring;
      const rotated = new CredentialService(parseKeyRing(generateKeyFile(original)));
      expect(await rotated.rewrapAll(db)).toBeGreaterThanOrEqual(1);
      const row = (
        await db.query<{
          id: string;
          mfa_kek_version: number;
          mfa_wrapped_dek: Buffer;
          mfa_ciphertext: Buffer;
        }>(
          "SELECT id, mfa_kek_version, mfa_wrapped_dek, mfa_ciphertext FROM users WHERE email = 'owner@arc.test'",
        )
      ).rows[0]!;
      expect(row.mfa_kek_version).toBe(2);
      expect(
        rotated.openUserSecret(row.id, {
          kekVersion: row.mfa_kek_version,
          wrappedDek: row.mfa_wrapped_dek,
          ciphertext: row.mfa_ciphertext,
        }),
      ).toBe(secret);
      credentials = rotated;
      await app.close();
      app = build({});
    });

    it('turning it off needs the password and a code', async () => {
      const { mfaToken } = (await login(OWNER.email, OWNER.password)).json();
      const owner = call(
        cookieOf(await anon('POST', '/auth/login/mfa', { mfaToken, code: recovery[2]! })),
      );
      expect(
        (
          await owner('POST', '/account/mfa/disable', {
            password: 'wrong-password-1',
            code: recovery[3]!,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await owner('POST', '/account/mfa/disable', {
            password: OWNER.password,
            code: recovery[3]!,
          })
        ).statusCode,
      ).toBe(200);
      expect((await login(OWNER.email, OWNER.password)).json()).toEqual({ ok: true });
    });
  });

  describe('password reset by email', () => {
    it('never says whether an account exists', async () => {
      const before = mailer.sent.length;
      const r = await anon('POST', '/auth/password-reset/request', {
        email: 'nobody@example.test',
      });
      expect(r.statusCode).toBe(202);
      expect(mailer.sent.length).toBe(before);
    });

    it('emails a one-time link; the new password works and every session ends', async () => {
      const old = call(cookieOf(await login(OWNER.email, OWNER.password)));
      const r = await anon('POST', '/auth/password-reset/request', {
        email: 'OWNER@arc.test',
        app: 'console',
      });
      expect(r.statusCode).toBe(202);
      const mail = mailer.sent.at(-1)!;
      expect(mail.text).toContain(`${PUBLIC}/console/reset#arcr_`);
      const token = mailer.tokenFor('owner@arc.test');
      expect(
        (await anon('POST', '/auth/password-reset/complete', { token, newPassword: 'short' }))
          .statusCode,
      ).toBe(400);
      expect(
        (
          await anon('POST', '/auth/password-reset/complete', {
            token,
            newPassword: 'a-brand-new-password',
          })
        ).statusCode,
      ).toBe(200);
      expect((await old('GET', '/auth/me')).statusCode).toBe(401);
      expect((await login(OWNER.email, 'a-brand-new-password')).statusCode).toBe(200);
      expect(
        (
          await anon('POST', '/auth/password-reset/complete', {
            token,
            newPassword: 'another-password-9',
          })
        ).statusCode,
      ).toBe(410);
      OWNER.password = 'a-brand-new-password';
    });
  });

  describe('email verification (open sign-up)', () => {
    it('open sign-ups confirm their email before creating apps', async () => {
      const res = await openApp.inject({
        method: 'POST',
        url: '/admin/v1/auth/signup',
        payload: {
          email: 'new@example.test',
          password: 'new-user-password-1',
          organization: 'New Co',
        },
      });
      expect(res.json()).toMatchObject({ emailVerified: false });
      const me = call(cookieOf(res), () => openApp);
      expect((await me('GET', '/auth/me')).json().user.emailVerified).toBe(false);
      const blocked = await me('POST', '/applications', { name: 'A', slug: 'a-app' });
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json().error.code).toBe('email_unverified');

      const token = mailer.tokenFor('new@example.test');
      expect((await anon('POST', '/auth/verify-email', { token })).statusCode).toBe(200);
      expect((await anon('POST', '/auth/verify-email', { token })).statusCode).toBe(410);
      expect((await me('POST', '/applications', { name: 'A', slug: 'a-app' })).statusCode).toBe(
        201,
      );
    });
  });

  describe('Google sign-in', () => {
    async function start(body: object = {}) {
      const r = await anon('POST', '/auth/google/start', body);
      const url = new URL(r.json().url);
      google.state.challenge = url.searchParams.get('code_challenge')!;
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('redirect_uri')).toBe(`${PUBLIC}/admin/v1/auth/google/callback`);
      return url.searchParams.get('state')!;
    }
    const callback = (state: string, code = 'good-code') =>
      app.inject({
        method: 'GET',
        url: `/admin/v1/auth/google/callback?code=${code}&state=${state}`,
      });

    it('refuses unknown people without an invitation', async () => {
      google.state.profile = { sub: 'g-x', email: 'stranger@example.test', email_verified: true };
      const r = await callback(await start());
      expect(r.statusCode).toBe(302);
      expect(r.headers.location).toBe(`${PUBLIC}/dashboard/#google=no-account`);
    });

    it('signs in an existing account with the same verified email and links it', async () => {
      google.state.profile = { sub: 'g-owner', email: 'owner@arc.test', email_verified: true };
      const state = await start({ app: 'console' });
      const r = await callback(state);
      expect(r.headers.location).toBe(`${PUBLIC}/console/#google=ok`);
      expect(cookieOf(r)).not.toBe('');
      // State is single-use.
      expect((await callback(state)).headers.location).toBe(`${PUBLIC}/dashboard/#google=expired`);
      // A different Google account with the same email can't take it over.
      google.state.profile = { sub: 'g-other', email: 'owner@arc.test', email_verified: true };
      expect((await callback(await start())).headers.location).toContain('google=mismatch');
    });

    it('rejects unverified Google emails and a bad code', async () => {
      google.state.profile = { sub: 'g-u', email: 'u@example.test', email_verified: false };
      expect((await callback(await start())).headers.location).toContain('google=unverified');
      google.state.profile = { sub: 'g-owner', email: 'owner@arc.test', email_verified: true };
      expect((await callback(await start(), 'bad-code')).headers.location).toContain(
        'google=failed',
      );
    });

    it('creates an account from an invitation', async () => {
      const ownerCookie = cookieOf(await login(OWNER.email, OWNER.password));
      const inv = await call(ownerCookie)('POST', '/console/invitations', {
        email: 'ada@example.test',
      });
      google.state.profile = { sub: 'g-ada', email: 'ada@example.test', email_verified: true };
      const needsOrg = await callback(await start({ inviteToken: inv.json().token }));
      expect(needsOrg.headers.location).toContain('google=needs-organization');
      const r = await callback(
        await start({ inviteToken: inv.json().token, organization: 'Ada Co' }),
      );
      expect(r.headers.location).toBe(`${PUBLIC}/dashboard/#google=ok`);
      const me = (await call(cookieOf(r))('GET', '/auth/me')).json();
      expect(me.user).toMatchObject({ email: 'ada@example.test', emailVerified: true });
      expect(me.tenants).toMatchObject([{ name: 'Ada Co', role: 'owner' }]);
    });

    it('still asks for the second step when two-step sign-in is on', async () => {
      const owner = call(cookieOf(await login(OWNER.email, OWNER.password)));
      const { secret } = (await owner('POST', '/account/mfa/setup')).json();
      await owner('POST', '/account/mfa/enable', { code: nowCode(secret) });
      google.state.profile = { sub: 'g-owner', email: 'owner@arc.test', email_verified: true };
      const r = await callback(await start());
      expect(cookieOf(r)).toBe('');
      const mfaToken = r.headers.location!.split('#mfa=')[1]!;
      expect(mfaToken).toMatch(/^arcm_/);
      const ok = await anon('POST', '/auth/login/mfa', { mfaToken, code: nextCode(secret) });
      expect(ok.statusCode).toBe(200);
    });
  });
});
