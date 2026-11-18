import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/pool.js';
import { ArcError, forbidden, unauthenticated } from '../errors.js';
import { SESSION_COOKIE, type SessionUser, resolveSession } from './sessions.js';

export type Role = 'owner' | 'admin' | 'member';
export type TenantKind = 'platform' | 'personal' | 'organization';

export interface TenantContext {
  tenantId: string;
  tenantKind: TenantKind;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

export const TENANT_HEADER = 'x-arc-tenant';
const ROLE_RANK: Record<Role, number> = { member: 1, admin: 2, owner: 3 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** preHandler: require a valid session cookie. */
export function requireUser(db: Db) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const token = req.cookies[SESSION_COOKIE];
    const user = token ? await resolveSession(db, token) : null;
    if (!user) throw unauthenticated();
    req.user = user;
  };
}

export function currentUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw unauthenticated();
  return req.user;
}

export function requireSuperadmin(req: FastifyRequest): SessionUser {
  const user = currentUser(req);
  if (!user.isSuperadmin) throw forbidden('Platform superadmin only');
  return user;
}

/**
 * Resolve the tenant this request acts on. Uses the x-arc-tenant header, or the user's
 * only membership. Membership is always required: superadmin does not bypass tenant isolation.
 */
export async function tenantContext(
  db: Db,
  req: FastifyRequest,
  minRole: Role,
): Promise<TenantContext> {
  const user = currentUser(req);
  const header = req.headers[TENANT_HEADER];
  const requested = Array.isArray(header) ? header[0] : header;
  if (requested !== undefined && !UUID.test(requested)) {
    throw new ArcError(400, 'invalid_tenant', `${TENANT_HEADER} must be a tenant id`);
  }

  const { rows } = await db.query<{ tenant_id: string; kind: TenantKind; role: Role }>(
    `SELECT m.tenant_id, t.kind, m.role
       FROM memberships m JOIN tenants t ON t.id = m.tenant_id
      WHERE m.user_id = $1 AND t.suspended_at IS NULL
        AND ($2::uuid IS NULL OR m.tenant_id = $2::uuid)`,
    [user.userId, requested ?? null],
  );

  if (rows.length === 0) throw forbidden('You are not a member of this tenant');
  if (rows.length > 1) {
    throw new ArcError(400, 'tenant_required', `Set ${TENANT_HEADER} to choose a tenant`);
  }
  const m = rows[0]!;
  if (ROLE_RANK[m.role] < ROLE_RANK[minRole]) throw forbidden(`Requires ${minRole} role`);
  return { tenantId: m.tenant_id, tenantKind: m.kind, role: m.role };
}
