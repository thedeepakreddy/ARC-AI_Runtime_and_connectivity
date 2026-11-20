import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import { currentUser, requireUser, tenantContext } from '../auth/context.js';
import { withTransaction } from '../db/pool.js';
import { ArcError, notFound, parseInput } from '../errors.js';
import { type AdminDeps, isUniqueViolation } from './deps.js';
import { assertPublicHttpsUrl } from '../providers/url-guard.js';
import { validateAccount } from '../providers/validation.js';

const ACCOUNT_COLUMNS = `a.id, a.provider_id AS "providerId", a.label, a.scope, a.base_url AS "baseUrl",
  a.enabled, a.health_status AS "healthStatus", a.last_validated_at AS "lastValidatedAt",
  a.last_validation_error AS "lastValidationError", c.secret_hint AS "secretHint",
  a.created_at AS "createdAt", a.updated_at AS "updatedAt"`;

const idParam = z.object({ id: z.uuid() });
const apiKey = z.string().trim().min(8).max(4096);
const baseUrl = z.url({ protocol: /^https?$/ }).max(2000);

const createSchema = z.object({
  providerId: z.string().min(1).max(64),
  label: z.string().trim().min(1).max(100),
  apiKey,
  baseUrl: baseUrl.optional(),
  enabled: z.boolean().optional(),
});

const updateSchema = z
  .object({
    label: z.string().trim().min(1).max(100).optional(),
    enabled: z.boolean().optional(),
    baseUrl: baseUrl.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field');

const listQuery = z.object({ provider: z.string().max(64).optional() });

export async function accountRoutes(app: FastifyInstance, deps: AdminDeps): Promise<void> {
  const { db, credentials, probe } = deps;
  const guard = deps.assertPublicUrl ?? assertPublicHttpsUrl;
  app.addHook('preHandler', requireUser(db));
  app.addHook('onResponse', async (req, reply) => {
    if (req.method !== 'GET' && reply.statusCode < 400) deps.onRoutingChange?.();
  });

  /** Customer-supplied URLs may only reach the public internet (SSRF protection). */
  async function checkBaseUrl(tenantKind: string, url: string | null | undefined): Promise<void> {
    if (url && tenantKind !== 'platform') await guard(url);
  }

  async function loadAccount(tenantId: string, id: string) {
    const { rows } = await db.query(
      `SELECT ${ACCOUNT_COLUMNS}, a.credential_id AS "credentialId",
              p.adapter, p.default_base_url AS "defaultBaseUrl"
         FROM provider_accounts a
         JOIN credentials c ON c.id = a.credential_id
         JOIN providers p ON p.id = a.provider_id
        WHERE a.id = $1 AND a.tenant_id = $2 AND a.scope <> 'end_user'`,
      [id, tenantId],
    );
    const row = rows[0];
    if (!row) throw notFound('Provider account');
    return row as Record<string, unknown> & {
      id: string;
      credentialId: string;
      providerId: string;
      adapter: 'litellm_native' | 'openai_compatible';
      baseUrl: string | null;
      defaultBaseUrl: string | null;
    };
  }

  function publicView(row: Record<string, unknown>) {
    const { credentialId: _c, adapter: _a, defaultBaseUrl: _d, ...rest } = row;
    return rest;
  }

  app.get('/provider-accounts', async (req) => {
    const t = await tenantContext(db, req, 'admin');
    const q = parseInput(listQuery, req.query);
    const { rows } = await db.query(
      `SELECT ${ACCOUNT_COLUMNS}
         FROM provider_accounts a JOIN credentials c ON c.id = a.credential_id
        WHERE a.tenant_id = $1 AND a.scope <> 'end_user'
          AND ($2::text IS NULL OR a.provider_id = $2)
        ORDER BY a.provider_id, a.label`,
      [t.tenantId, q.provider ?? null],
    );
    return { data: rows };
  });

  app.get('/provider-accounts/:id', async (req) => {
    const t = await tenantContext(db, req, 'admin');
    const { id } = parseInput(idParam, req.params);
    return publicView(await loadAccount(t.tenantId, id));
  });

  app.post('/provider-accounts', async (req, reply) => {
    const user = currentUser(req);
    const t = await tenantContext(db, req, 'admin');
    const body = parseInput(createSchema, req.body);
    // Scope comes from the tenant, never from input: owner keys stay private to the platform.
    const scope = t.tenantKind === 'platform' ? 'owner_private' : 'tenant_byok';

    await checkBaseUrl(t.tenantKind, body.baseUrl);
    const provider = await db.query('SELECT 1 FROM providers WHERE id = $1', [body.providerId]);
    if (!provider.rowCount) throw notFound('Provider');

    try {
      const id = await withTransaction(db, async (tx) => {
        const cred = await credentials.store(tx, t.tenantId, body.apiKey);
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO provider_accounts (tenant_id, provider_id, label, scope, credential_id, base_url, enabled)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [
            t.tenantId,
            body.providerId,
            body.label,
            scope,
            cred.id,
            body.baseUrl ?? null,
            body.enabled ?? true,
          ],
        );
        const accountId = rows[0]!.id;
        await recordAudit(tx, {
          tenantId: t.tenantId,
          actorUserId: user.userId,
          action: 'provider_account.created',
          targetType: 'provider_account',
          targetId: accountId,
          metadata: { providerId: body.providerId, label: body.label },
        });
        return accountId;
      });
      return reply.code(201).send(publicView(await loadAccount(t.tenantId, id)));
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ArcError(
          409,
          'label_taken',
          'A key with this label already exists for this provider',
        );
      }
      throw err;
    }
  });

  app.patch('/provider-accounts/:id', async (req) => {
    const user = currentUser(req);
    const t = await tenantContext(db, req, 'admin');
    const { id } = parseInput(idParam, req.params);
    const body = parseInput(updateSchema, req.body);
    await loadAccount(t.tenantId, id);
    await checkBaseUrl(t.tenantKind, body.baseUrl);
    try {
      await db.query(
        `UPDATE provider_accounts SET
           label = COALESCE($3, label),
           enabled = COALESCE($4, enabled),
           base_url = CASE WHEN $5 THEN $6 ELSE base_url END,
           updated_at = now()
         WHERE id = $1 AND tenant_id = $2`,
        [
          id,
          t.tenantId,
          body.label ?? null,
          body.enabled ?? null,
          body.baseUrl !== undefined,
          body.baseUrl ?? null,
        ],
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ArcError(
          409,
          'label_taken',
          'A key with this label already exists for this provider',
        );
      }
      throw err;
    }
    await recordAudit(db, {
      tenantId: t.tenantId,
      actorUserId: user.userId,
      action: 'provider_account.updated',
      targetType: 'provider_account',
      targetId: id,
      metadata: { fields: Object.keys(body) },
    });
    return publicView(await loadAccount(t.tenantId, id));
  });

  /** Replace the key itself. The old encrypted credential is deleted. */
  app.put('/provider-accounts/:id/credential', async (req) => {
    const user = currentUser(req);
    const t = await tenantContext(db, req, 'admin');
    const { id } = parseInput(idParam, req.params);
    const body = parseInput(z.object({ apiKey }), req.body);
    const account = await loadAccount(t.tenantId, id);
    await withTransaction(db, async (tx) => {
      const cred = await credentials.store(tx, t.tenantId, body.apiKey);
      await tx.query(
        `UPDATE provider_accounts SET credential_id = $3, health_status = 'unknown',
                last_validated_at = NULL, last_validation_error = NULL, updated_at = now()
          WHERE id = $1 AND tenant_id = $2`,
        [id, t.tenantId, cred.id],
      );
      await credentials.remove(tx, t.tenantId, account.credentialId);
      await recordAudit(tx, {
        tenantId: t.tenantId,
        actorUserId: user.userId,
        action: 'provider_account.credential_replaced',
        targetType: 'provider_account',
        targetId: id,
      });
    });
    return publicView(await loadAccount(t.tenantId, id));
  });

  app.delete('/provider-accounts/:id', async (req, reply) => {
    const user = currentUser(req);
    const t = await tenantContext(db, req, 'admin');
    const { id } = parseInput(idParam, req.params);
    const account = await loadAccount(t.tenantId, id);
    await withTransaction(db, async (tx) => {
      await tx.query('DELETE FROM provider_accounts WHERE id = $1 AND tenant_id = $2', [
        id,
        t.tenantId,
      ]);
      await credentials.remove(tx, t.tenantId, account.credentialId);
      await recordAudit(tx, {
        tenantId: t.tenantId,
        actorUserId: user.userId,
        action: 'provider_account.deleted',
        targetType: 'provider_account',
        targetId: id,
        metadata: { providerId: account.providerId },
      });
    });
    return reply.code(204).send();
  });

  /** Check the key against the provider and record the models it can see. */
  app.post('/provider-accounts/:id/validate', async (req) => {
    const user = currentUser(req);
    const t = await tenantContext(db, req, 'admin');
    const { id } = parseInput(idParam, req.params);
    const account = await loadAccount(t.tenantId, id);
    // Re-check at use time: DNS may have changed since the URL was saved.
    await checkBaseUrl(t.tenantKind, account.baseUrl);
    return validateAccount(
      db,
      credentials,
      probe,
      { ...account, tenantId: t.tenantId },
      deps.probeTimeoutMs,
      user.userId,
    );
  });
}
