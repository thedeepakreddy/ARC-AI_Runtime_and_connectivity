import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import { currentUser, requireUser } from '../auth/context.js';
import { PASSWORD_MAX_LENGTH, verifyAgainstDummy, verifyPassword } from '../auth/password.js';
import { SESSION_COOKIE, revokeSession } from '../auth/sessions.js';
import { localThrottle } from '../coordination/throttle.js';
import { ArcError, parseInput } from '../errors.js';
import type { AdminDeps } from './deps.js';
import { finishSignIn } from './security.js';

const loginSchema = z.object({
  email: z.email().max(320),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

/** The session cookie: HttpOnly, SameSite=Strict, scoped to the admin API. */
export function setSessionCookie(reply: FastifyReply, token: string, deps: AdminDeps): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: deps.cookieSecure,
    sameSite: 'strict',
    path: '/admin',
    maxAge: Math.floor(deps.sessionTtlMs / 1000),
  });
}

export async function authRoutes(app: FastifyInstance, deps: AdminDeps): Promise<void> {
  const { db } = deps;
  const throttle = deps.throttle ?? localThrottle;
  const perEmail = throttle('login-email', 10, 15 * 60_000);
  const perIp = throttle('login-ip', 50, 15 * 60_000);
  const invalid = () => new ArcError(401, 'invalid_credentials', 'Email or password is incorrect');

  app.post('/auth/login', async (req, reply) => {
    const body = parseInput(loginSchema, req.body);
    const emailKey = body.email.toLowerCase();
    if (!(await perIp.hit(req.ip)) || !(await perEmail.hit(emailKey))) {
      throw new ArcError(429, 'too_many_attempts', 'Too many sign-in attempts. Try again later.');
    }

    const { rows } = await db.query<{
      id: string;
      password_hash: string;
      disabled_at: Date | null;
    }>('SELECT id, password_hash, disabled_at FROM users WHERE lower(email) = $1', [emailKey]);
    const user = rows[0];
    const ok = user
      ? await verifyPassword(body.password, user.password_hash)
      : await verifyAgainstDummy(body.password);
    if (!user || !ok || user.disabled_at) {
      await recordAudit(db, {
        tenantId: null,
        actorUserId: user?.id ?? null,
        action: 'auth.login_failed',
      });
      throw invalid();
    }

    await perEmail.reset(emailKey);
    // A session now, or the second step when two-step sign-in is on.
    return finishSignIn(db, deps, req, reply, user.id, 'password');
  });

  app.register(async (authed) => {
    authed.addHook('preHandler', requireUser(db));

    authed.get('/auth/me', async (req) => {
      const user = currentUser(req);
      const { rows } = await db.query(
        `SELECT t.id, t.kind, t.name, m.role
           FROM memberships m JOIN tenants t ON t.id = m.tenant_id
          WHERE m.user_id = $1 ORDER BY t.created_at`,
        [user.userId],
      );
      return {
        user: {
          id: user.userId,
          email: user.email,
          isSuperadmin: user.isSuperadmin,
          emailVerified: user.emailVerified,
        },
        tenants: rows,
      };
    });

    authed.post('/auth/logout', async (req, reply) => {
      const user = currentUser(req);
      await revokeSession(db, user.sessionId);
      await recordAudit(db, { tenantId: null, actorUserId: user.userId, action: 'auth.logout' });
      reply.clearCookie(SESSION_COOKIE, { path: '/admin' });
      return { ok: true };
    });
  });
}
