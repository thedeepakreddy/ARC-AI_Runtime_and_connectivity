import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import { currentUser, requireUser } from '../auth/context.js';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  hashPassword,
  verifyPassword,
} from '../auth/password.js';
import { createSession } from '../auth/sessions.js';
import { findToken, issueToken, spendToken } from '../auth/tokens.js';
import { matchTotp, newTotpSecret, otpauthUri } from '../auth/totp.js';
import { localThrottle } from '../coordination/throttle.js';
import { type Db, type Queryable, withTransaction } from '../db/pool.js';
import { ArcError, parseInput } from '../errors.js';
import { setSessionCookie } from './auth.js';
import type { AdminDeps } from './deps.js';

/**
 * Account security for everyone (owner and customers): two-step sign-in (TOTP + recovery
 * codes), password reset and email verification by email, and Google sign-in.
 *
 * Tokens are random, single-use, short-lived, stored as SHA-256 only, and always travel in
 * request bodies or URL fragments, never in URLs a server logs.
 */

const RESET_TTL_MS = 30 * 60_000;
const VERIFY_TTL_MS = 48 * 3_600_000;
const MFA_LOGIN_TTL_MS = 5 * 60_000;
const OAUTH_TTL_MS = 10 * 60_000;
const MFA_MAX_ATTEMPTS = 5;
const RECOVERY_CODES = 10;

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest();
const password = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);
const code = z.string().trim().min(6).max(20);

/** Where a link in an email or a Google redirect should land. */
type App = 'console' | 'dashboard';

/**
 * The end of every successful first factor (password or Google): either a session, or — when
 * the user has two-step sign-in on — a short-lived challenge for the second step.
 */
export async function finishSignIn(
  db: Db,
  deps: AdminDeps,
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  method: 'password' | 'google',
): Promise<{ ok: true } | { mfaRequired: true; mfaToken: string }> {
  const { rows } = await db.query<{ mfa_enabled_at: Date | null }>(
    'SELECT mfa_enabled_at FROM users WHERE id = $1',
    [userId],
  );
  if (rows[0]?.mfa_enabled_at) {
    const mfaToken = await issueToken(db, {
      purpose: 'mfa_login',
      userId,
      ttlMs: MFA_LOGIN_TTL_MS,
      data: { method },
    });
    return { mfaRequired: true, mfaToken };
  }
  await startSession(db, deps, req, reply, userId, method);
  return { ok: true };
}

async function startSession(
  db: Db,
  deps: AdminDeps,
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  method: string,
) {
  const token = await createSession(db, userId, deps.sessionTtlMs, req.headers['user-agent']);
  await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
  await recordAudit(db, {
    tenantId: null,
    actorUserId: userId,
    action: 'auth.login',
    metadata: { method },
  });
  setSessionCookie(reply, token, deps);
}

interface MfaUser {
  id: string;
  mfa_kek_version: number | null;
  mfa_wrapped_dek: Buffer | null;
  mfa_ciphertext: Buffer | null;
  mfa_enabled_at: Date | null;
  mfa_last_step: string | null;
}

async function loadMfa(q: Queryable, userId: string): Promise<MfaUser> {
  const { rows } = await q.query<MfaUser>(
    `SELECT id, mfa_kek_version, mfa_wrapped_dek, mfa_ciphertext, mfa_enabled_at, mfa_last_step
       FROM users WHERE id = $1`,
    [userId],
  );
  return rows[0]!;
}

function newRecoveryCodes(): string[] {
  // 10 codes like "k7m2-9qxp-4tdh": 60 bits each, easy to type.
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: RECOVERY_CODES }, () => {
    const bytes = randomBytes(12);
    const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
    return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
  });
}
const normalizeRecovery = (c: string) => c.toLowerCase().replace(/[^a-z0-9]/g, '');

async function replaceRecoveryCodes(q: Queryable, userId: string): Promise<string[]> {
  const codes = newRecoveryCodes();
  await q.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId]);
  for (const c of codes) {
    await q.query('INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)', [
      userId,
      sha(normalizeRecovery(c)),
    ]);
  }
  return codes;
}

export async function securityRoutes(app: FastifyInstance, deps: AdminDeps): Promise<void> {
  const { db, credentials, mailer } = deps;
  const throttle = deps.throttle ?? localThrottle;
  const resetPerIp = throttle('reset-ip', 20, 60 * 60_000);
  const resetPerEmail = throttle('reset-email', 5, 60 * 60_000);
  const linkBase = (appName: App) => `${deps.publicUrl?.replace(/\/$/, '') ?? ''}/${appName}`;

  /**
   * Check a TOTP code or a recovery code for a user with two-step sign-in on. TOTP codes are
   * accepted once (the step is recorded); recovery codes are spent.
   */
  async function checkSecondFactor(q: Queryable, user: MfaUser, input: string): Promise<boolean> {
    if (!user.mfa_ciphertext || user.mfa_kek_version === null || !user.mfa_wrapped_dek)
      return false;
    const secret = credentials.openUserSecret(user.id, {
      kekVersion: user.mfa_kek_version,
      wrappedDek: user.mfa_wrapped_dek,
      ciphertext: user.mfa_ciphertext,
    });
    const step = matchTotp(secret, input);
    if (step !== null) {
      const r = await q.query(
        `UPDATE users SET mfa_last_step = $2
          WHERE id = $1 AND (mfa_last_step IS NULL OR mfa_last_step < $2)`,
        [user.id, step],
      );
      return (r.rowCount ?? 0) > 0;
    }
    const recovery = normalizeRecovery(input);
    if (recovery.length !== 12) return false;
    const r = await q.query(
      `UPDATE mfa_recovery_codes SET used_at = now()
        WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
      [user.id, sha(recovery)],
    );
    if ((r.rowCount ?? 0) > 0) {
      await recordAudit(q, {
        tenantId: null,
        actorUserId: user.id,
        action: 'auth.recovery_code_used',
      });
      return true;
    }
    return false;
  }

  // ---------- Public ----------

  /** The second sign-in step: { mfaToken, code } (a 6-digit code or a recovery code). */
  app.post('/auth/login/mfa', async (req, reply) => {
    const body = parseInput(z.object({ mfaToken: z.string().max(100), code }), req.body);
    const t = await findToken(db, body.mfaToken, 'mfa_login');
    if (!t?.user_id) {
      throw new ArcError(401, 'mfa_expired', 'Sign-in expired. Start again.');
    }
    // A few tries per challenge, then the challenge is gone.
    await db.query('UPDATE auth_tokens SET attempts = attempts + 1 WHERE id = $1', [t.id]);
    if (t.attempts + 1 > MFA_MAX_ATTEMPTS) {
      await spendToken(db, t.id);
      throw new ArcError(429, 'too_many_attempts', 'Too many codes. Sign in again.');
    }
    const user = await loadMfa(db, t.user_id);
    if (!(await checkSecondFactor(db, user, body.code))) {
      await recordAudit(db, { tenantId: null, actorUserId: user.id, action: 'auth.mfa_failed' });
      throw new ArcError(401, 'invalid_code', 'That code didn’t work. Try the newest one.');
    }
    if (!(await spendToken(db, t.id))) {
      throw new ArcError(401, 'mfa_expired', 'Sign-in expired. Start again.');
    }
    await startSession(db, deps, req, reply, user.id, `${String(t.data.method ?? 'password')}+mfa`);
    return { ok: true };
  });

  /** Always the same answer, so it never tells whether an account exists. */
  app.post('/auth/password-reset/request', async (req, reply) => {
    const body = parseInput(
      z.object({
        email: z.email().max(320),
        app: z.enum(['console', 'dashboard']).default('dashboard'),
      }),
      req.body,
    );
    if (!mailer) {
      throw new ArcError(
        501,
        'email_not_configured',
        'Password reset by email isn’t set up on this ARC.',
      );
    }
    const emailKey = body.email.toLowerCase();
    if (!(await resetPerIp.hit(req.ip)) || !(await resetPerEmail.hit(emailKey))) {
      return reply.code(202).send({ ok: true });
    }
    const { rows } = await db.query<{ id: string; email: string }>(
      'SELECT id, email FROM users WHERE lower(email) = $1 AND disabled_at IS NULL',
      [emailKey],
    );
    const user = rows[0];
    if (user) {
      const token = await issueToken(db, {
        purpose: 'password_reset',
        userId: user.id,
        ttlMs: RESET_TTL_MS,
      });
      await mailer
        .send({
          to: user.email,
          subject: 'Reset your ARC password',
          text:
            `Someone asked to reset the password for ${user.email} on ARC.\n\n` +
            `Choose a new password here (the link works once, for 30 minutes):\n` +
            `${linkBase(body.app)}/reset#${token}\n\n` +
            `If it wasn't you, ignore this email: your password stays the same.\n`,
        })
        .catch(() => undefined);
      await recordAudit(db, {
        tenantId: null,
        actorUserId: user.id,
        action: 'auth.reset_requested',
      });
    }
    return reply.code(202).send({ ok: true });
  });

  /** { token, newPassword }: sets the password and signs out every session. */
  app.post('/auth/password-reset/complete', async (req) => {
    const body = parseInput(
      z.object({ token: z.string().max(100), newPassword: password }),
      req.body,
    );
    const t = await findToken(db, body.token, 'password_reset');
    if (!t?.user_id) {
      throw new ArcError(
        410,
        'reset_invalid',
        'This link has expired or was used. Ask for a new one.',
      );
    }
    const hash = await hashPassword(body.newPassword);
    await withTransaction(db, async (tx) => {
      if (!(await spendToken(tx, t.id))) {
        throw new ArcError(410, 'reset_invalid', 'This link has expired or was used.');
      }
      // Reaching the inbox proves the address too.
      await tx.query(
        `UPDATE users SET password_hash = $2, email_verified_at = coalesce(email_verified_at, now())
          WHERE id = $1`,
        [t.user_id, hash],
      );
      await tx.query(
        'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
        [t.user_id],
      );
      await recordAudit(tx, {
        tenantId: null,
        actorUserId: t.user_id,
        action: 'auth.password_reset',
      });
    });
    return { ok: true };
  });

  /** { token } from the verification email. */
  app.post('/auth/verify-email', async (req) => {
    const body = parseInput(z.object({ token: z.string().max(100) }), req.body);
    const t = await findToken(db, body.token, 'email_verify');
    if (!t?.user_id || !(await spendToken(db, t.id))) {
      throw new ArcError(410, 'verify_invalid', 'This link has expired or was used.');
    }
    await db.query(
      'UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1',
      [t.user_id],
    );
    await recordAudit(db, {
      tenantId: null,
      actorUserId: t.user_id,
      action: 'auth.email_verified',
    });
    return { ok: true };
  });

  // ---------- Google sign-in ----------

  const google = deps.google;
  if (google) {
    const authUrl = google.authUrl ?? 'https://accounts.google.com/o/oauth2/v2/auth';
    const tokenUrl = google.tokenUrl ?? 'https://oauth2.googleapis.com/token';
    const userinfoUrl = google.userinfoUrl ?? 'https://openidconnect.googleapis.com/v1/userinfo';
    const redirectUri = `${deps.publicUrl?.replace(/\/$/, '')}/admin/v1/auth/google/callback`;

    /**
     * Start: { app, inviteToken?, organization? } → { url } to send the browser to. The PKCE
     * verifier and the invitation stay server-side, tied to a random state.
     */
    app.post('/auth/google/start', async (req) => {
      const body = parseInput(
        z.object({
          app: z.enum(['console', 'dashboard']).default('dashboard'),
          inviteToken: z.string().max(100).optional(),
          organization: z.string().trim().min(1).max(200).optional(),
        }),
        req.body ?? {},
      );
      const verifier = randomBytes(32).toString('base64url');
      const state = await issueToken(db, {
        purpose: 'oauth_state',
        userId: null,
        ttlMs: OAUTH_TTL_MS,
        data: {
          verifier,
          app: body.app,
          ...(body.inviteToken ? { inviteHash: sha(body.inviteToken).toString('hex') } : {}),
          ...(body.organization ? { organization: body.organization } : {}),
        },
      });
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const url = new URL(authUrl);
      url.search = new URLSearchParams({
        client_id: google.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
      }).toString();
      return { url: url.toString() };
    });

    /**
     * Google sends the browser back here. The code is single-use and the state is spent at
     * once, so this URL is worthless after the redirect. Outcomes go to the app in a fragment.
     */
    app.get('/auth/google/callback', async (req, reply) => {
      const q = parseInput(
        z.object({
          code: z.string().max(2000).optional(),
          state: z.string().max(100),
          error: z.string().max(200).optional(),
        }),
        req.query,
      );
      const st = await findToken(db, q.state, 'oauth_state');
      const appName: App = st?.data.app === 'console' ? 'console' : 'dashboard';
      const back = (fragment: string) => reply.redirect(`${linkBase(appName)}/#${fragment}`);
      if (!st || !(await spendToken(db, st.id))) return back('google=expired');
      if (q.error || !q.code) return back('google=cancelled');

      let profile: { sub: string; email: string; email_verified: boolean };
      try {
        const tokenRes = await fetch(tokenUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: q.code,
            client_id: google.clientId,
            client_secret: google.clientSecret,
            redirect_uri: redirectUri,
            code_verifier: String(st.data.verifier),
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!tokenRes.ok) return back('google=failed');
        const { access_token } = (await tokenRes.json()) as { access_token?: string };
        const infoRes = await fetch(userinfoUrl, {
          headers: { authorization: `Bearer ${access_token}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!infoRes.ok) return back('google=failed');
        profile = (await infoRes.json()) as typeof profile;
      } catch {
        return back('google=failed');
      }
      if (!profile.sub || !profile.email || profile.email_verified !== true) {
        return back('google=unverified');
      }

      const email = profile.email.toLowerCase();
      const existing = await db.query<{
        id: string;
        google_sub: string | null;
        disabled_at: Date | null;
      }>(
        'SELECT id, google_sub, disabled_at FROM users WHERE google_sub = $1 OR lower(email) = $2 ORDER BY google_sub IS NULL LIMIT 1',
        [profile.sub, email],
      );
      let userId = existing.rows[0]?.id;
      if (existing.rows[0]?.disabled_at) return back('google=disabled');
      if (
        existing.rows[0] &&
        existing.rows[0].google_sub &&
        existing.rows[0].google_sub !== profile.sub
      ) {
        return back('google=mismatch');
      }

      if (!userId) {
        // New people need an invitation for this email (or open sign-up with an organization).
        const inviteHash =
          typeof st.data.inviteHash === 'string' ? Buffer.from(st.data.inviteHash, 'hex') : null;
        const inv = inviteHash
          ? (
              await db.query<{ id: string; tenant_id: string | null; email: string; role: string }>(
                `SELECT id, tenant_id, email, role FROM invitations
                  WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
                [inviteHash],
              )
            ).rows[0]
          : undefined;
        const organization = typeof st.data.organization === 'string' ? st.data.organization : null;
        if (inv && inv.email.toLowerCase() !== email) return back('google=wrong-account');
        if (!inv && deps.signupMode !== 'open') return back('google=no-account');
        if ((!inv || !inv.tenant_id) && !organization) return back('google=needs-organization');
        userId = await withTransaction(db, async (tx) => {
          // No usable password: they can set one later with "forgot password".
          const u = await tx.query<{ id: string }>(
            `INSERT INTO users (email, password_hash, google_sub, email_verified_at)
             VALUES ($1, $2, $3, now()) RETURNING id`,
            [profile.email, await hashPassword(randomBytes(32).toString('base64url')), profile.sub],
          );
          const id = u.rows[0]!.id;
          let tenantId = inv?.tenant_id ?? null;
          let role = inv?.tenant_id ? inv.role : 'owner';
          if (!tenantId) {
            const t = await tx.query<{ id: string }>(
              "INSERT INTO tenants (kind, name) VALUES ('organization', $1) RETURNING id",
              [organization],
            );
            tenantId = t.rows[0]!.id;
            role = 'owner';
          }
          await tx.query('INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)', [
            tenantId,
            id,
            role,
          ]);
          if (inv)
            await tx.query('UPDATE invitations SET accepted_at = now() WHERE id = $1', [inv.id]);
          await recordAudit(tx, {
            tenantId,
            actorUserId: id,
            action: inv ? 'invitation.accepted' : 'auth.signup',
            targetType: 'tenant',
            targetId: tenantId,
            metadata: { method: 'google' },
          });
          return id;
        });
      } else {
        // Google confirmed this address: link it, and count the email as verified.
        await db.query(
          `UPDATE users SET google_sub = $2, email_verified_at = coalesce(email_verified_at, now())
            WHERE id = $1`,
          [userId, profile.sub],
        );
      }

      const result = await finishSignIn(db, deps, req, reply, userId, 'google');
      return 'mfaToken' in result ? back(`mfa=${result.mfaToken}`) : back('google=ok');
    });
  }

  // ---------- Signed in ----------

  app.register(async (authed) => {
    authed.addHook('preHandler', requireUser(db));

    authed.post('/auth/verify-email/send', async (req) => {
      const user = currentUser(req);
      const body = parseInput(
        z.object({ app: z.enum(['console', 'dashboard']).default('dashboard') }),
        req.body ?? {},
      );
      if (user.emailVerified) return { ok: true, alreadyVerified: true };
      if (!mailer) {
        throw new ArcError(501, 'email_not_configured', 'Email isn’t set up on this ARC.');
      }
      await sendVerification(db, deps, user.userId, user.email, body.app);
      return { ok: true };
    });

    authed.get('/account/security', async (req) => {
      const user = currentUser(req);
      const { rows } = await db.query<{
        mfa_enabled_at: Date | null;
        google_sub: string | null;
        email_verified_at: Date | null;
        codes_left: number;
      }>(
        `SELECT u.mfa_enabled_at, u.google_sub, u.email_verified_at,
                (SELECT count(*)::int FROM mfa_recovery_codes r WHERE r.user_id = u.id AND r.used_at IS NULL) AS codes_left
           FROM users u WHERE u.id = $1`,
        [user.userId],
      );
      const r = rows[0]!;
      return {
        mfaEnabled: r.mfa_enabled_at !== null,
        recoveryCodesLeft: r.codes_left,
        google: r.google_sub !== null,
        emailVerified: r.email_verified_at !== null,
        email: !!mailer,
        googleSignIn: !!deps.google,
      };
    });

    /** Step 1: a new secret (pending until confirmed with a code). */
    authed.post('/account/mfa/setup', async (req) => {
      const user = currentUser(req);
      const current = await loadMfa(db, user.userId);
      if (current.mfa_enabled_at) {
        throw new ArcError(409, 'mfa_enabled', 'Two-step sign-in is already on.');
      }
      const secret = newTotpSecret();
      const sealed = credentials.sealUserSecret(user.userId, secret);
      await db.query(
        `UPDATE users SET mfa_kek_version = $2, mfa_wrapped_dek = $3, mfa_ciphertext = $4,
                mfa_enabled_at = NULL, mfa_last_step = NULL WHERE id = $1`,
        [user.userId, sealed.kekVersion, sealed.wrappedDek, sealed.ciphertext],
      );
      return { secret, otpauthUrl: otpauthUri(secret, user.email) };
    });

    /** Step 2: { code } from the authenticator → on, plus recovery codes (shown once). */
    authed.post('/account/mfa/enable', async (req) => {
      const user = currentUser(req);
      const body = parseInput(z.object({ code }), req.body);
      const codes = await withTransaction(db, async (tx) => {
        const u = await loadMfa(tx, user.userId);
        if (u.mfa_enabled_at)
          throw new ArcError(409, 'mfa_enabled', 'Two-step sign-in is already on.');
        if (!u.mfa_ciphertext) throw new ArcError(400, 'mfa_not_started', 'Start the setup first.');
        if (!(await checkSecondFactor(tx, u, body.code))) {
          throw new ArcError(
            400,
            'invalid_code',
            'That code didn’t work. Check the time on your phone and try the newest code.',
          );
        }
        await tx.query('UPDATE users SET mfa_enabled_at = now() WHERE id = $1', [user.userId]);
        const fresh = await replaceRecoveryCodes(tx, user.userId);
        await recordAudit(tx, {
          tenantId: null,
          actorUserId: user.userId,
          action: 'auth.mfa_enabled',
        });
        return fresh;
      });
      return { recoveryCodes: codes };
    });

    /** { password, code } — both factors to turn it off. */
    authed.post('/account/mfa/disable', async (req) => {
      const user = currentUser(req);
      const body = parseInput(
        z.object({ password: z.string().min(1).max(PASSWORD_MAX_LENGTH), code }),
        req.body,
      );
      await withTransaction(db, async (tx) => {
        const hash = await tx.query<{ password_hash: string }>(
          'SELECT password_hash FROM users WHERE id = $1',
          [user.userId],
        );
        if (!(await verifyPassword(body.password, hash.rows[0]!.password_hash))) {
          throw new ArcError(400, 'invalid_password', 'Your password is incorrect.');
        }
        const u = await loadMfa(tx, user.userId);
        if (!u.mfa_enabled_at) return;
        if (!(await checkSecondFactor(tx, u, body.code))) {
          throw new ArcError(400, 'invalid_code', 'That code didn’t work.');
        }
        await tx.query(
          `UPDATE users SET mfa_kek_version = NULL, mfa_wrapped_dek = NULL, mfa_ciphertext = NULL,
                  mfa_enabled_at = NULL, mfa_last_step = NULL WHERE id = $1`,
          [user.userId],
        );
        await tx.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [user.userId]);
        await recordAudit(tx, {
          tenantId: null,
          actorUserId: user.userId,
          action: 'auth.mfa_disabled',
        });
      });
      return { ok: true };
    });

    /** { code } → a fresh set of recovery codes; the old ones stop working. */
    authed.post('/account/mfa/recovery-codes', async (req) => {
      const user = currentUser(req);
      const body = parseInput(z.object({ code }), req.body);
      const codes = await withTransaction(db, async (tx) => {
        const u = await loadMfa(tx, user.userId);
        if (!u.mfa_enabled_at) throw new ArcError(400, 'mfa_off', 'Two-step sign-in is off.');
        if (!(await checkSecondFactor(tx, u, body.code))) {
          throw new ArcError(400, 'invalid_code', 'That code didn’t work.');
        }
        const fresh = await replaceRecoveryCodes(tx, user.userId);
        await recordAudit(tx, {
          tenantId: null,
          actorUserId: user.userId,
          action: 'auth.recovery_codes_replaced',
        });
        return fresh;
      });
      return { recoveryCodes: codes };
    });
  });
}

/** Email a verification link (sign-up without an invitation, or on request). */
export async function sendVerification(
  db: Db,
  deps: AdminDeps,
  userId: string,
  email: string,
  appName: App = 'dashboard',
): Promise<void> {
  if (!deps.mailer) return;
  const token = await issueToken(db, { purpose: 'email_verify', userId, ttlMs: VERIFY_TTL_MS });
  await deps.mailer
    .send({
      to: email,
      subject: 'Confirm your email for ARC',
      text:
        `Confirm that ${email} is yours to finish setting up ARC:\n` +
        `${deps.publicUrl?.replace(/\/$/, '') ?? ''}/${appName}/verify#${token}\n\n` +
        `The link works once, for 48 hours. If you didn't sign up, ignore this email.\n`,
    })
    .catch(() => undefined);
}
