import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import { currentUser, requireUser, tenantContext } from '../auth/context.js';
import { ArcError, notFound, parseInput } from '../errors.js';
import { rankCandidates } from '../inference/candidates.js';
import type { Capability } from '../inference/schemas.js';
import { CAPABILITIES } from './catalogue.js';
import type { AdminDeps } from './deps.js';

const JURISDICTIONS = ['US', 'EU', 'UK', 'CA', 'CN', 'SELF_HOSTED'] as const;

const policySchema = z.object({
  /** null = every jurisdiction allowed. */
  allowedJurisdictions: z.array(z.enum(JURISDICTIONS)).min(1).max(JURISDICTIONS.length).nullable(),
  allowPaidOwnerKeys: z.boolean().default(false),
});

const appParam = z.object({ appId: z.uuid() });

const explainSchema = z.object({
  model: z.string().min(1).max(320).default('auto'),
  applicationId: z.uuid().optional(),
  capabilities: z.array(z.enum(CAPABILITIES)).max(CAPABILITIES.length).default(['text']),
});

const POLICY_COLUMNS = `application_id AS "applicationId", allowed_jurisdictions AS "allowedJurisdictions",
  allow_paid_owner_keys AS "allowPaidOwnerKeys", updated_at AS "updatedAt"`;

export async function routingRoutes(app: FastifyInstance, deps: AdminDeps): Promise<void> {
  const { db } = deps;
  app.addHook('preHandler', requireUser(db));

  async function assertApp(tenantId: string, appId: string): Promise<void> {
    const r = await db.query('SELECT 1 FROM applications WHERE id = $1 AND tenant_id = $2', [
      appId,
      tenantId,
    ]);
    if (!r.rowCount) throw notFound('Application');
  }

  async function getPolicy(tenantId: string, appId: string | null) {
    const { rows } = await db.query(
      `SELECT ${POLICY_COLUMNS} FROM routing_policies
        WHERE tenant_id = $1 AND application_id IS NOT DISTINCT FROM $2::uuid`,
      [tenantId, appId],
    );
    return rows[0] ?? null;
  }

  async function putPolicy(req: Parameters<typeof currentUser>[0], appId: string | null) {
    const user = currentUser(req);
    const t = await tenantContext(db, req, 'owner');
    if (appId) await assertApp(t.tenantId, appId);
    const body = parseInput(policySchema, req.body);
    // Paid use of owner keys needs explicit approval by the platform owner (blueprint §5).
    if (body.allowPaidOwnerKeys && !(t.tenantKind === 'platform' && user.isSuperadmin)) {
      throw new ArcError(
        403,
        'forbidden',
        'Only the platform owner can allow paid models on owner keys',
      );
    }
    const { rows } = await db.query(
      `INSERT INTO routing_policies (tenant_id, application_id, allowed_jurisdictions, allow_paid_owner_keys, updated_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, COALESCE(application_id, '00000000-0000-0000-0000-000000000000'::uuid))
       DO UPDATE SET allowed_jurisdictions = EXCLUDED.allowed_jurisdictions,
                     allow_paid_owner_keys = EXCLUDED.allow_paid_owner_keys,
                     updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING ${POLICY_COLUMNS}`,
      [t.tenantId, appId, body.allowedJurisdictions, body.allowPaidOwnerKeys, user.userId],
    );
    await recordAudit(db, {
      tenantId: t.tenantId,
      actorUserId: user.userId,
      action: 'routing_policy.updated',
      targetType: appId ? 'application' : 'tenant',
      targetId: appId ?? t.tenantId,
      metadata: {
        allowedJurisdictions: body.allowedJurisdictions,
        allowPaidOwnerKeys: body.allowPaidOwnerKeys,
      },
    });
    deps.onRoutingChange?.();
    return rows[0];
  }

  app.get('/routing/policy', async (req) => {
    const t = await tenantContext(db, req, 'admin');
    return (
      (await getPolicy(t.tenantId, null)) ?? {
        applicationId: null,
        allowedJurisdictions: null,
        allowPaidOwnerKeys: false,
      }
    );
  });
  app.put('/routing/policy', async (req) => putPolicy(req, null));

  app.get('/applications/:appId/routing-policy', async (req) => {
    const t = await tenantContext(db, req, 'admin');
    const { appId } = parseInput(appParam, req.params);
    await assertApp(t.tenantId, appId);
    return {
      policy: await getPolicy(t.tenantId, appId),
      inheritsTenantPolicy: !(await getPolicy(t.tenantId, appId)),
    };
  });
  app.put('/applications/:appId/routing-policy', async (req) => {
    const { appId } = parseInput(appParam, req.params);
    return putPolicy(req, appId);
  });
  app.delete('/applications/:appId/routing-policy', async (req, reply) => {
    const user = currentUser(req);
    const t = await tenantContext(db, req, 'owner');
    const { appId } = parseInput(appParam, req.params);
    await assertApp(t.tenantId, appId);
    await db.query('DELETE FROM routing_policies WHERE tenant_id = $1 AND application_id = $2', [
      t.tenantId,
      appId,
    ]);
    await recordAudit(db, {
      tenantId: t.tenantId,
      actorUserId: user.userId,
      action: 'routing_policy.cleared',
      targetType: 'application',
      targetId: appId,
    });
    deps.onRoutingChange?.();
    return reply.code(204).send();
  });

  /** Dry run: how would ARC route this request right now, and why. No provider is called. */
  app.post('/routing/explain', async (req) => {
    const t = await tenantContext(db, req, 'admin');
    const body = parseInput(explainSchema, req.body ?? {});
    const routing = deps.routing;
    if (!routing)
      throw new ArcError(503, 'routing_unavailable', 'Routing is not enabled on this instance');
    if (body.applicationId) await assertApp(t.tenantId, body.applicationId);
    const [all, policy] = await Promise.all([
      routing.candidates.forTenant(t.tenantId),
      routing.candidates.policyFor(t.tenantId, body.applicationId ?? null),
    ]);
    const ranking = rankCandidates(all, {
      requested: body.model,
      need: new Set(body.capabilities as Capability[]),
      policy,
      cooldown: (id) => routing.cooldowns.get(id),
    });
    const policyView = {
      allowedJurisdictions: policy.allowedJurisdictions ? [...policy.allowedJurisdictions] : null,
      allowPaidOwnerKeys: policy.allowPaidOwnerKeys,
    };
    if (!('plan' in ranking)) {
      return {
        routable: false,
        reason: ranking.reason,
        policy: policyView,
        candidates: ranking.verdicts,
      };
    }
    return {
      routable: true,
      selected: ranking.verdicts.find((v) => v.verdict === 'selected'),
      fallbackOrder: ranking.plan.map((c) => ({
        model: `${c.providerId}/${c.modelId}`,
        accountId: c.accountId,
      })),
      rejected: ranking.rejected,
      policy: policyView,
      candidates: ranking.verdicts,
    };
  });
}
