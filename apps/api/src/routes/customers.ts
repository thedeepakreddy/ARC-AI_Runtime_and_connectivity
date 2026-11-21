import { createHash, randomBytes } from 'node:crypto';
import { defaultWorkspaceName } from '../auth/workspace.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import {
  type Role,
  currentUser,
  requireSuperadmin,
  requireUser,
  tenantContext,
} from '../auth/context.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, hashPassword } from '../auth/password.js';
import { createSession } from '../auth/sessions.js';
import { localThrottle } from '../coordination/throttle.js';
import { type Queryable, withTransaction } from '../db/pool.js';
import { ArcError, forbidden, notFound, parseInput } from '../errors.js';
import { setSessionCookie } from './auth.js';
import { sendVerification } from './security.js';
import { trafficQuery, trafficReport } from './console.js';
import { type AdminDeps, isUniqueViolation } from './deps.js';

/**
 * Customers: sign-up, invitations, their team, their organization and their usage.
 *
 * Every tenant route resolves the tenant from the session's memberships (tenantContext), so a
 * customer can only ever see or change their own tenant. Invitation links carry a random token;
 * only its SHA-256 is stored, and the link is shown once to whoever created it.
 */

const INVITE_PREFIX = 'arci_';
const INVITE_TTL_DAYS = 7;
const ROLE_RANK: Record<Role, number> = { member: 1, admin: 2, owner: 3 };

const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest();
const newToken = () => INVITE_PREFIX + randomBytes(32).toString('base64url');

const email = z.email().max(320);
const orgName = z.string().trim().min(1).max(200);
const password = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);
const role = z.enum(['owner', 'admin', 'member']);
const inviteToken = z.string().startsWith(INVITE_PREFIX).max(100);
// Tokens travel in request bodies, never URLs, so they can't end up in access logs.
const tokenBody = z.object({ token: inviteToken });
const idParam = z.object({ id: z.uuid() });
const userParam = z.object({ userId: z.uuid() });

const signupSchema = z.object({
  email,
  password,
  /** Required unless the invitation is to an existing tenant. */
  organization: orgName.optional(),
  inviteToken: inviteToken.optional(),
});
const inviteSchema = z.object({ email, role: role.default('member') });
const customerInviteSchema = z.object({ email });
const roleSchema = z.object({ role });
const tenantSchema = z.object({ name: orgName });

interface Invitation {
  id: string;
  tenant_id: string | null;
  tenant_name: string | null;
  email: string;
  role: Role;
  expires_at: Date;
}

/** A pending (not accepted, revoked or expired) invitation by its token, or null. */
async function pendingInvitation(q: Queryable, token: string): Promise<Invitation | null> {
  const { rows } = await q.query<Invitation>(
    `SELECT i.id, i.tenant_id, t.name AS tenant_name, i.email, i.role, i.expires_at
       FROM invitations i LEFT JOIN tenants t ON t.id = i.tenant_id
      WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
        AND i.expires_at > now() AND (i.tenant_id IS NULL OR t.suspended_at IS NULL)`,
    [hashToken(token)],
  );
  return rows[0] ?? null;
}

/** Create an invitation (replacing any pending one for the same email and tenant). */
async function createInvitation(
  q: Queryable,
  args: { tenantId: string | null; email: string; role: Role; invitedBy: string },
) {
  await q.query(
    `UPDATE invitations SET revoked_at = now()
      WHERE tenant_id IS NOT DISTINCT FROM $1 AND lower(email) = lower($2)
        AND accepted_at IS NULL AND revoked_at IS NULL`,
    [args.tenantId, args.email],
  );
  const token = newToken();
  const { rows } = await q.query<{ id: string; created_at: Date; expires_at: Date }>(
    `INSERT INTO invitations (tenant_id, email, role, token_hash, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6))
     RETURNING id, created_at, expires_at`,
    [args.tenantId, args.email, args.role, hashToken(token), args.invitedBy, INVITE_TTL_DAYS],
  );
  const r = rows[0]!;
  return {
    id: r.id,
    email: args.email,
    role: args.role,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    /** Shown once. The link is `/dashboard/invite#<token>` (a fragment never reaches a server). */
    token,
  };
}

const INVITATION_COLUMNS = `i.id, i.email, i.role, i.created_at AS "createdAt", i.expires_at AS "expiresAt",
  u.email AS "invitedBy"`;

export async function customerRoutes(app: FastifyInstance, deps: AdminDeps): Promise<void> {
  const { db } = deps;
  const signupMode = deps.signupMode ?? 'invite';
  const throttle = deps.throttle ?? localThrottle;
  const perIp = throttle('signup-ip', 20, 60 * 60_000);
  const lookups = throttle('invite-lookup-ip', 60, 15 * 60_000);

  // ---------- Public: what sign-up allows, invitation preview, sign-up ----------

  app.get('/auth/config', async () => ({
    signup: signupMode,
    passwordReset: !!deps.mailer,
    google: !!deps.google,
    ads: deps.ads ?? null,
  }));

  app.post('/auth/invitations/preview', async (req) => {
    if (!(await lookups.hit(req.ip))) {
      throw new ArcError(429, 'too_many_attempts', 'Too many attempts. Try again later.');
    }
    const { token } = parseInput(tokenBody, req.body);
    const inv = await pendingInvitation(db, token);
    if (!inv) throw notFound('Invitation');
    return {
      email: inv.email,
      role: inv.role,
      organization: inv.tenant_name,
      newOrganization: inv.tenant_id === null,
      expiresAt: inv.expires_at,
    };
  });

  app.post('/auth/signup', async (req, reply) => {
    if (!(await perIp.hit(req.ip))) {
      throw new ArcError(429, 'too_many_attempts', 'Too many sign-ups. Try again later.');
    }
    const body = parseInput(signupSchema, req.body);
    const invitation = body.inviteToken ? await pendingInvitation(db, body.inviteToken) : null;
    if (body.inviteToken && !invitation) {
      throw new ArcError(410, 'invitation_invalid', 'This invitation has expired or was used.');
    }
    if (!invitation && signupMode !== 'open') {
      throw new ArcError(403, 'invitation_required', 'Sign-up is by invitation only.');
    }
    if (invitation && invitation.email.toLowerCase() !== body.email.toLowerCase()) {
      throw new ArcError(
        400,
        'invitation_email_mismatch',
        `This invitation is for ${invitation.email}.`,
      );
    }
    const joinsExisting = invitation?.tenant_id ?? null;
    // Without a name, a new person gets their own workspace named after them (renamable).
    const newOrganization = body.organization || defaultWorkspaceName(body.email);

    const passwordHash = await hashPassword(body.password);
    let userId: string;
    try {
      userId = await withTransaction(db, async (tx) => {
        // An invitation was for this exact address, so it's vouched for. Open sign-ups confirm
        // by email (when ARC can send email; otherwise there is nothing to confirm with).
        const verified = !!invitation || !deps.mailer;
        const u = await tx.query<{ id: string }>(
          `INSERT INTO users (email, password_hash, email_verified_at)
           VALUES ($1, $2, CASE WHEN $3::boolean THEN now() END) RETURNING id`,
          [body.email, passwordHash, verified],
        );
        const id = u.rows[0]!.id;
        let tenantId = joinsExisting;
        let memberRole: Role = invitation?.role ?? 'owner';
        if (!tenantId) {
          const t = await tx.query<{ id: string }>(
            "INSERT INTO tenants (kind, name) VALUES ('organization', $1) RETURNING id",
            [newOrganization],
          );
          tenantId = t.rows[0]!.id;
          memberRole = 'owner';
        }
        await tx.query('INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)', [
          tenantId,
          id,
          memberRole,
        ]);
        if (invitation) {
          await tx.query('UPDATE invitations SET accepted_at = now() WHERE id = $1', [
            invitation.id,
          ]);
        }
        await recordAudit(tx, {
          tenantId,
          actorUserId: id,
          action: invitation ? 'invitation.accepted' : 'auth.signup',
          targetType: 'tenant',
          targetId: tenantId,
          metadata: { role: memberRole, newOrganization: !joinsExisting },
        });
        return id;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ArcError(
          409,
          'account_exists',
          'This email already has an account. Sign in, then open the invitation again.',
        );
      }
      throw err;
    }
    const token = await createSession(db, userId, deps.sessionTtlMs, req.headers['user-agent']);
    await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
    setSessionCookie(reply, token, deps);
    if (!invitation) await sendVerification(db, deps, userId, body.email);
    return reply.code(201).send({ ok: true, emailVerified: !!invitation || !deps.mailer });
  });

  // ---------- Signed in ----------

  app.register(async (authed) => {
    authed.addHook('preHandler', requireUser(db));

    /** An existing user accepts an invitation to another tenant (or a new organization). */
    authed.post('/auth/invitations/accept', async (req) => {
      const user = currentUser(req);
      const body = parseInput(tokenBody.extend({ organization: orgName.optional() }), req.body);
      const token = body.token;
      const inv = await pendingInvitation(db, token);
      if (!inv)
        throw new ArcError(410, 'invitation_invalid', 'This invitation has expired or was used.');
      if (inv.email.toLowerCase() !== user.email.toLowerCase()) {
        throw forbidden(`This invitation is for ${inv.email}.`);
      }
      if (!inv.tenant_id && !body.organization) {
        throw new ArcError(400, 'validation_error', 'Name your organization.');
      }
      const tenantId = await withTransaction(db, async (tx) => {
        let id = inv.tenant_id;
        if (!id) {
          const t = await tx.query<{ id: string }>(
            "INSERT INTO tenants (kind, name) VALUES ('organization', $1) RETURNING id",
            [body.organization],
          );
          id = t.rows[0]!.id;
        }
        await tx.query(
          `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, user_id) DO NOTHING`,
          [id, user.userId, inv.tenant_id ? inv.role : 'owner'],
        );
        await tx.query('UPDATE invitations SET accepted_at = now() WHERE id = $1', [inv.id]);
        await recordAudit(tx, {
          tenantId: id,
          actorUserId: user.userId,
          action: 'invitation.accepted',
          targetType: 'tenant',
          targetId: id,
        });
        return id;
      });
      return { tenantId };
    });

    // ----- The tenant itself -----

    authed.get('/tenant', async (req) => {
      const t = await tenantContext(db, req, 'member');
      const { rows } = await db.query(
        'SELECT id, kind, name, created_at AS "createdAt" FROM tenants WHERE id = $1',
        [t.tenantId],
      );
      return { ...rows[0], role: t.role };
    });

    authed.patch('/tenant', async (req) => {
      const user = currentUser(req);
      const t = await tenantContext(db, req, 'owner');
      const body = parseInput(tenantSchema, req.body);
      await db.query('UPDATE tenants SET name = $2 WHERE id = $1', [t.tenantId, body.name]);
      await recordAudit(db, {
        tenantId: t.tenantId,
        actorUserId: user.userId,
        action: 'tenant.renamed',
        targetType: 'tenant',
        targetId: t.tenantId,
      });
      return { id: t.tenantId, name: body.name };
    });

    authed.get('/usage', async (req) => {
      const t = await tenantContext(db, req, 'member');
      const q = parseInput(trafficQuery, req.query);
      if (q.app) {
        const own = await db.query('SELECT 1 FROM applications WHERE id = $1 AND tenant_id = $2', [
          q.app,
          t.tenantId,
        ]);
        if (!own.rowCount) throw notFound('Application');
      }
      return trafficReport(db, q, t.tenantId);
    });

    // ----- Models on the customer's own keys: the customer decides -----

    const tenantModelParam = z.object({ id: z.uuid() });
    const tenantModelBody = z.object({ enabled: z.boolean().nullable() });
    /** Models at least one of this tenant's own keys can reach. */
    const SEEN_BY_TENANT = `SELECT 1 FROM account_models am
        JOIN provider_accounts a ON a.id = am.account_id
       WHERE am.model_id = m.id AND a.tenant_id = $1 AND a.scope = 'tenant_byok'`;

    authed.get('/tenant/models', async (req) => {
      const t = await tenantContext(db, req, 'admin');
      if (t.tenantKind === 'platform') {
        throw forbidden('The platform owner classifies models in the console');
      }
      const { rows } = await db.query(
        `SELECT m.id, m.provider_id AS "providerId", m.model_id AS "modelId",
                m.display_name AS "displayName", m.capabilities, m.eligibility,
                m.terms_note AS "termsNote", m.enabled AS "arcEnabled", tm.enabled AS choice,
                coalesce(tm.enabled, m.enabled) AS enabled
           FROM models m
           LEFT JOIN tenant_models tm ON tm.tenant_id = $1 AND tm.model_id = m.id
          WHERE EXISTS (${SEEN_BY_TENANT})
          ORDER BY m.provider_id, m.model_id`,
        [t.tenantId],
      );
      return { data: rows };
    });

    /** { enabled: true | false } decides; null goes back to following ARC's classification. */
    authed.put('/tenant/models/:id', async (req) => {
      const user = currentUser(req);
      const t = await tenantContext(db, req, 'admin');
      if (t.tenantKind === 'platform') {
        throw forbidden('The platform owner classifies models in the console');
      }
      const { id } = parseInput(tenantModelParam, req.params);
      const { enabled } = parseInput(tenantModelBody, req.body);
      const seen = await db.query(
        `SELECT 1 FROM models m WHERE m.id = $2 AND EXISTS (${SEEN_BY_TENANT})`,
        [t.tenantId, id],
      );
      if (!seen.rowCount) throw notFound('Model');
      if (enabled === null) {
        await db.query('DELETE FROM tenant_models WHERE tenant_id = $1 AND model_id = $2', [
          t.tenantId,
          id,
        ]);
      } else {
        await db.query(
          `INSERT INTO tenant_models (tenant_id, model_id, enabled) VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, model_id) DO UPDATE SET enabled = $3, updated_at = now()`,
          [t.tenantId, id, enabled],
        );
      }
      await recordAudit(db, {
        tenantId: t.tenantId,
        actorUserId: user.userId,
        action: 'tenant_model.changed',
        targetType: 'model',
        targetId: id,
        metadata: { enabled },
      });
      deps.onRoutingChange?.();
      return { id, choice: enabled };
    });

    // ----- Team: members and invitations -----

    authed.get('/members', async (req) => {
      const user = currentUser(req);
      const t = await tenantContext(db, req, 'member');
      const { rows } = await db.query<{ userId: string }>(
        `SELECT u.id AS "userId", u.email, m.role, m.created_at AS "joinedAt",
                u.last_login_at AS "lastLoginAt"
           FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.tenant_id = $1
          ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.email`,
        [t.tenantId],
      );
      return { data: rows.map((r) => ({ ...r, you: r.userId === user.userId })) };
    });

    /** Owners left after a change; the last owner can't be removed or demoted. */
    async function assertOwnerRemains(q: Queryable, tenantId: string, userId: string) {
      const { rows } = await q.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM memberships
          WHERE tenant_id = $1 AND role = 'owner' AND user_id <> $2`,
        [tenantId, userId],
      );
      if (rows[0]!.n === 0) {
        throw new ArcError(409, 'last_owner', 'An organization needs at least one owner.');
      }
    }

    async function memberRole(tenantId: string, userId: string): Promise<Role> {
      const { rows } = await db.query<{ role: Role }>(
        'SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2',
        [tenantId, userId],
      );
      if (!rows[0]) throw notFound('Member');
      return rows[0].role;
    }

    authed.patch('/members/:userId', async (req) => {
      const user = currentUser(req);
      const t = await tenantContext(db, req, 'owner');
      const { userId } = parseInput(userParam, req.params);
      const body = parseInput(roleSchema, req.body);
      const current = await memberRole(t.tenantId, userId);
      if (current === 'owner' && body.role !== 'owner') {
        await assertOwnerRemains(db, t.tenantId, userId);
      }
      await db.query('UPDATE memberships SET role = $3 WHERE tenant_id = $1 AND user_id = $2', [
        t.tenantId,
        userId,
        body.role,
      ]);
      await recordAudit(db, {
        tenantId: t.tenantId,
        actorUserId: user.userId,
        action: 'member.role_changed',
        targetType: 'user',
        targetId: userId,
        metadata: { from: current, to: body.role },
      });
      return { userId, role: body.role };
    });

    authed.delete('/members/:userId', async (req, reply) => {
      const user = currentUser(req);
      const { userId } = parseInput(userParam, req.params);
      const self = userId === user.userId;
      // Anyone may leave; removing someone else needs admin, and removing an owner needs owner.
      const t = await tenantContext(db, req, self ? 'member' : 'admin');
      const target = await memberRole(t.tenantId, userId);
      if (!self && ROLE_RANK[target] > ROLE_RANK[t.role]) {
        throw forbidden(`Requires ${target} role`);
      }
      if (target === 'owner') await assertOwnerRemains(db, t.tenantId, userId);
      await db.query('DELETE FROM memberships WHERE tenant_id = $1 AND user_id = $2', [
        t.tenantId,
        userId,
      ]);
      await recordAudit(db, {
        tenantId: t.tenantId,
        actorUserId: user.userId,
        action: self ? 'member.left' : 'member.removed',
        targetType: 'user',
        targetId: userId,
      });
      return reply.code(204).send();
    });

    authed.get('/invitations', async (req) => {
      const t = await tenantContext(db, req, 'admin');
      const { rows } = await db.query(
        `SELECT ${INVITATION_COLUMNS}
           FROM invitations i LEFT JOIN users u ON u.id = i.invited_by
          WHERE i.tenant_id = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
            AND i.expires_at > now()
          ORDER BY i.created_at DESC`,
        [t.tenantId],
      );
      return { data: rows };
    });

    authed.post('/invitations', async (req, reply) => {
      const user = currentUser(req);
      const t = await tenantContext(db, req, 'admin');
      const body = parseInput(inviteSchema, req.body);
      if (ROLE_RANK[body.role] > ROLE_RANK[t.role]) {
        throw forbidden(`Only an ${body.role} can invite an ${body.role}`);
      }
      const member = await db.query(
        `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.tenant_id = $1 AND lower(u.email) = lower($2)`,
        [t.tenantId, body.email],
      );
      if (member.rowCount) {
        throw new ArcError(409, 'already_member', `${body.email} is already a member.`);
      }
      const inv = await withTransaction(db, async (tx) => {
        const created = await createInvitation(tx, {
          tenantId: t.tenantId,
          email: body.email,
          role: body.role,
          invitedBy: user.userId,
        });
        await recordAudit(tx, {
          tenantId: t.tenantId,
          actorUserId: user.userId,
          action: 'invitation.created',
          targetType: 'invitation',
          targetId: created.id,
          metadata: { role: body.role },
        });
        return created;
      });
      return reply.code(201).send(inv);
    });

    authed.delete('/invitations/:id', async (req, reply) => {
      const user = currentUser(req);
      const t = await tenantContext(db, req, 'admin');
      const { id } = parseInput(idParam, req.params);
      const r = await db.query(
        `UPDATE invitations SET revoked_at = now()
          WHERE id = $1 AND tenant_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
        [id, t.tenantId],
      );
      if (!r.rowCount) throw notFound('Invitation');
      await recordAudit(db, {
        tenantId: t.tenantId,
        actorUserId: user.userId,
        action: 'invitation.revoked',
        targetType: 'invitation',
        targetId: id,
      });
      return reply.code(204).send();
    });

    // ----- Owner: invite new customers -----

    authed.get('/console/invitations', async (req) => {
      requireSuperadmin(req);
      const { rows } = await db.query(
        `SELECT ${INVITATION_COLUMNS}
           FROM invitations i LEFT JOIN users u ON u.id = i.invited_by
          WHERE i.tenant_id IS NULL AND i.accepted_at IS NULL AND i.revoked_at IS NULL
            AND i.expires_at > now()
          ORDER BY i.created_at DESC`,
      );
      return { data: rows };
    });

    authed.post('/console/invitations', async (req, reply) => {
      const user = requireSuperadmin(req);
      const body = parseInput(customerInviteSchema, req.body);
      const inv = await withTransaction(db, async (tx) => {
        const created = await createInvitation(tx, {
          tenantId: null,
          email: body.email,
          role: 'owner',
          invitedBy: user.userId,
        });
        await recordAudit(tx, {
          tenantId: null,
          actorUserId: user.userId,
          action: 'invitation.created',
          targetType: 'invitation',
          targetId: created.id,
          metadata: { newOrganization: true },
        });
        return created;
      });
      return reply.code(201).send(inv);
    });

    authed.delete('/console/invitations/:id', async (req, reply) => {
      const user = requireSuperadmin(req);
      const { id } = parseInput(idParam, req.params);
      const r = await db.query(
        `UPDATE invitations SET revoked_at = now()
          WHERE id = $1 AND tenant_id IS NULL AND accepted_at IS NULL AND revoked_at IS NULL`,
        [id],
      );
      if (!r.rowCount) throw notFound('Invitation');
      await recordAudit(db, {
        tenantId: null,
        actorUserId: user.userId,
        action: 'invitation.revoked',
        targetType: 'invitation',
        targetId: id,
      });
      return reply.code(204).send();
    });
  });
}
