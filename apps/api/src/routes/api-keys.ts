import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import { currentUser, requireUser, tenantContext } from '../auth/context.js';
import { withTransaction } from '../db/pool.js';
import { notFound, parseInput } from '../errors.js';
import { generateArcKey } from '../keys/arc-keys.js';
import type { AdminDeps } from './deps.js';

const KEY_COLUMNS = `id, application_id AS "applicationId", name, display_prefix AS "displayPrefix", scopes,
  created_at AS "createdAt", last_used_at AS "lastUsedAt", expires_at AS "expiresAt", revoked_at AS "revokedAt"`;

const appParam = z.object({ appId: z.uuid() });
const idParam = z.object({ id: z.uuid() });
const rotateSchema = z
  .object({
    /** Keep the old key working this long, so the app can be updated without downtime. */
    overlapMinutes: z.union([z.literal(0), z.literal(60), z.literal(1440)]).default(0),
  })
  .default({ overlapMinutes: 0 });
const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z
    .array(z.enum(['inference', 'models:read']))
    .min(1)
    .max(2)
    .optional(),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});

export async function apiKeyRoutes(app: FastifyInstance, deps: AdminDeps): Promise<void> {
  const { db } = deps;
  app.addHook('preHandler', requireUser(db));

  async function assertApp(tenantId: string, appId: string): Promise<void> {
    const r = await db.query('SELECT 1 FROM applications WHERE id = $1 AND tenant_id = $2', [
      appId,
      tenantId,
    ]);
    if (!r.rowCount) throw notFound('Application');
  }

  async function issue(
    q: Parameters<typeof recordAudit>[0],
    tenantId: string,
    appId: string,
    userId: string,
    name: string,
    scopes: string[],
    expiresInDays: number | undefined,
  ) {
    const k = generateArcKey();
    const { rows } = await q.query(
      `INSERT INTO api_keys (tenant_id, application_id, key_id, secret_hash, display_prefix, name, scopes, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
               CASE WHEN $9::int IS NULL THEN NULL ELSE now() + make_interval(days => $9::int) END)
       RETURNING ${KEY_COLUMNS}`,
      [
        tenantId,
        appId,
        k.keyId,
        k.secretHash,
        k.displayPrefix,
        name,
        scopes,
        userId,
        expiresInDays ?? null,
      ],
    );
    await recordAudit(q, {
      tenantId,
      actorUserId: userId,
      action: 'api_key.created',
      targetType: 'api_key',
      targetId: rows[0].id,
      metadata: { applicationId: appId, displayPrefix: k.displayPrefix },
    });
    // The full key is returned exactly once and never stored.
    return { ...rows[0], key: k.key };
  }

  app.get('/applications/:appId/api-keys', async (req) => {
    const t = await tenantContext(db, req, 'admin');
    const { appId } = parseInput(appParam, req.params);
    await assertApp(t.tenantId, appId);
    const { rows } = await db.query(
      `SELECT ${KEY_COLUMNS} FROM api_keys WHERE tenant_id = $1 AND application_id = $2 ORDER BY created_at DESC`,
      [t.tenantId, appId],
    );
    return { data: rows };
  });

  app.post('/applications/:appId/api-keys', async (req, reply) => {
    const user = currentUser(req);
    const t = await tenantContext(db, req, 'admin');
    const { appId } = parseInput(appParam, req.params);
    const body = parseInput(createSchema, req.body);
    await assertApp(t.tenantId, appId);
    const created = await issue(
      db,
      t.tenantId,
      appId,
      user.userId,
      body.name,
      body.scopes ?? ['inference', 'models:read'],
      body.expiresInDays,
    );
    return reply.code(201).send(created);
  });

  async function revoke(
    q: Parameters<typeof recordAudit>[0],
    tenantId: string,
    id: string,
    userId: string,
  ) {
    const { rows } = await q.query<{
      key_id: string;
      application_id: string;
      name: string;
      scopes: string[];
    }>(
      `UPDATE api_keys SET revoked_at = now()
        WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL
        RETURNING key_id, application_id, name, scopes`,
      [id, tenantId],
    );
    const row = rows[0];
    if (!row) throw notFound('Active API key');
    await recordAudit(q, {
      tenantId,
      actorUserId: userId,
      action: 'api_key.revoked',
      targetType: 'api_key',
      targetId: id,
    });
    return row;
  }

  async function expireLater(
    q: Parameters<typeof recordAudit>[0],
    tenantId: string,
    id: string,
    userId: string,
    minutes: number,
  ) {
    const { rows } = await q.query<{
      key_id: string;
      application_id: string;
      name: string;
      scopes: string[];
    }>(
      `UPDATE api_keys
          SET expires_at = LEAST(coalesce(expires_at, 'infinity'), now() + make_interval(mins => $3))
        WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL
        RETURNING key_id, application_id, name, scopes`,
      [id, tenantId, minutes],
    );
    const row = rows[0];
    if (!row) throw notFound('Active API key');
    await recordAudit(q, {
      tenantId,
      actorUserId: userId,
      action: 'api_key.rotated_with_overlap',
      targetType: 'api_key',
      targetId: id,
      metadata: { overlapMinutes: minutes },
    });
    return row;
  }

  app.delete('/api-keys/:id', async (req, reply) => {
    const user = currentUser(req);
    const t = await tenantContext(db, req, 'admin');
    const { id } = parseInput(idParam, req.params);
    const row = await revoke(db, t.tenantId, id, user.userId);
    deps.onApiKeyRevoked?.(row.key_id);
    return reply.code(204).send();
  });

  /**
   * Issue a replacement with the same name and scopes. The old key is revoked at once, or keeps
   * working for an overlap (1 h or 24 h) and then expires, so the app can switch without downtime.
   */
  app.post('/api-keys/:id/rotate', async (req, reply) => {
    const user = currentUser(req);
    const t = await tenantContext(db, req, 'admin');
    const { id } = parseInput(idParam, req.params);
    const { overlapMinutes } = parseInput(rotateSchema, req.body ?? {});
    const { created, oldKeyId } = await withTransaction(db, async (tx) => {
      const old = overlapMinutes
        ? await expireLater(tx, t.tenantId, id, user.userId, overlapMinutes)
        : await revoke(tx, t.tenantId, id, user.userId);
      const fresh = await issue(
        tx,
        t.tenantId,
        old.application_id,
        user.userId,
        old.name,
        old.scopes,
        undefined,
      );
      return { created: fresh, oldKeyId: old.key_id };
    });
    deps.onApiKeyRevoked?.(oldKeyId);
    return reply.code(201).send(created);
  });
}
