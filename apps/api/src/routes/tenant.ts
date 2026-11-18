import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import { currentUser, requireUser, tenantContext } from '../auth/context.js';
import { ArcError, parseInput } from '../errors.js';
import { type AdminDeps, isUniqueViolation } from './deps.js';

const createAppSchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'lowercase letters, digits and dashes'),
  firstParty: z.boolean().optional(),
});

const auditQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

export async function tenantRoutes(app: FastifyInstance, deps: AdminDeps): Promise<void> {
  const { db } = deps;
  app.addHook('preHandler', requireUser(db));

  app.get('/applications', async (req) => {
    const t = await tenantContext(db, req, 'member');
    const { rows } = await db.query(
      `SELECT id, name, slug, first_party AS "firstParty", created_at AS "createdAt",
              disabled_at AS "disabledAt"
         FROM applications WHERE tenant_id = $1 ORDER BY name`,
      [t.tenantId],
    );
    return { data: rows };
  });

  app.post('/applications', async (req, reply) => {
    const user = currentUser(req);
    const t = await tenantContext(db, req, 'admin');
    const body = parseInput(createAppSchema, req.body);
    if (body.firstParty && t.tenantKind !== 'platform') {
      throw new ArcError(
        403,
        'forbidden',
        'Only the platform tenant can register first-party apps',
      );
    }
    try {
      const { rows } = await db.query(
        `INSERT INTO applications (tenant_id, name, slug, first_party) VALUES ($1, $2, $3, $4)
         RETURNING id, name, slug, first_party AS "firstParty", created_at AS "createdAt"`,
        [t.tenantId, body.name, body.slug, body.firstParty ?? false],
      );
      await recordAudit(db, {
        tenantId: t.tenantId,
        actorUserId: user.userId,
        action: 'application.created',
        targetType: 'application',
        targetId: rows[0].id,
        metadata: { slug: body.slug },
      });
      return reply.code(201).send(rows[0]);
    } catch (err) {
      if (isUniqueViolation(err))
        throw new ArcError(409, 'slug_taken', 'An app with this slug already exists');
      throw err;
    }
  });

  app.get('/audit-events', async (req) => {
    const t = await tenantContext(db, req, 'admin');
    const q = parseInput(auditQuery, req.query);
    const { rows } = await db.query(
      `SELECT id::text, actor_user_id AS "actorUserId", action, target_type AS "targetType",
              target_id AS "targetId", metadata, created_at AS "createdAt"
         FROM audit_events WHERE tenant_id = $1 ORDER BY id DESC LIMIT $2`,
      [t.tenantId, q.limit],
    );
    return { data: rows };
  });
}
