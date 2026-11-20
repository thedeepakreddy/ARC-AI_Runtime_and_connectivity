import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import { requireSuperadmin, requireUser } from '../auth/context.js';
import { ArcError, notFound, parseInput } from '../errors.js';
import { type AdminDeps, isUniqueViolation } from './deps.js';

export const CAPABILITIES = [
  'text',
  'vision',
  'audio_input',
  'transcription',
  'speech',
  'image_generation',
  'audio_output',
  'embeddings',
  'video',
  'documents',
  'streaming',
  'structured_output',
  'tools',
] as const;
export const ELIGIBILITY = ['VERIFIED_FREE', 'RESTRICTED_FREE', 'PAID', 'UNKNOWN'] as const;

const MODEL_COLUMNS = `id, provider_id AS "providerId", model_id AS "modelId", display_name AS "displayName",
  capabilities, eligibility, eligibility_evidence_url AS "eligibilityEvidenceUrl",
  eligibility_checked_at AS "eligibilityCheckedAt", terms_note AS "termsNote", enabled, source,
  created_at AS "createdAt", updated_at AS "updatedAt"`;

const idParam = z.object({ id: z.uuid() });

const listModelsQuery = z.object({
  provider: z.string().max(64).optional(),
  enabled: z.enum(['true', 'false']).optional(),
});

const createModelSchema = z.object({
  providerId: z.string().min(1).max(64),
  modelId: z.string().min(1).max(300),
  displayName: z.string().min(1).max(200).optional(),
  capabilities: z.array(z.enum(CAPABILITIES)).max(CAPABILITIES.length).optional(),
});

const updateModelSchema = z
  .object({
    displayName: z.string().min(1).max(200).nullable().optional(),
    capabilities: z.array(z.enum(CAPABILITIES)).max(CAPABILITIES.length).optional(),
    eligibility: z.enum(ELIGIBILITY).optional(),
    eligibilityEvidenceUrl: z.url().max(2000).optional(),
    enabled: z.boolean().optional(),
    /** The provider's terms for a restricted-free model, e.g. "50 requests/day". */
    termsNote: z.string().trim().max(500).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field');

export async function catalogueRoutes(app: FastifyInstance, deps: AdminDeps): Promise<void> {
  const { db } = deps;
  app.addHook('preHandler', requireUser(db));
  app.addHook('onResponse', async (req, reply) => {
    if (req.method !== 'GET' && reply.statusCode < 400) deps.onRoutingChange?.();
  });

  app.get('/providers', async () => {
    const { rows } = await db.query(
      `SELECT id, display_name AS "displayName", provider_group AS "group", jurisdiction, adapter,
              litellm_provider AS "litellmProvider", default_base_url AS "defaultBaseUrl",
              verified_at AS "verifiedAt"
         FROM providers ORDER BY provider_group, display_name`,
    );
    return { data: rows };
  });

  app.get('/models', async (req) => {
    const q = parseInput(listModelsQuery, req.query);
    const { rows } = await db.query(
      `SELECT ${MODEL_COLUMNS} FROM models
        WHERE ($1::text IS NULL OR provider_id = $1)
          AND ($2::boolean IS NULL OR enabled = $2)
        ORDER BY provider_id, model_id`,
      [q.provider ?? null, q.enabled === undefined ? null : q.enabled === 'true'],
    );
    return { data: rows };
  });

  app.post('/models', async (req, reply) => {
    const user = requireSuperadmin(req);
    const body = parseInput(createModelSchema, req.body);
    try {
      const { rows } = await db.query(
        `INSERT INTO models (provider_id, model_id, display_name, capabilities, source)
         VALUES ($1, $2, $3, $4, 'manual') RETURNING ${MODEL_COLUMNS}`,
        [body.providerId, body.modelId, body.displayName ?? null, body.capabilities ?? []],
      );
      await recordAudit(db, {
        tenantId: null,
        actorUserId: user.userId,
        action: 'model.created',
        targetType: 'model',
        targetId: rows[0].id,
        metadata: { providerId: body.providerId, modelId: body.modelId },
      });
      return reply.code(201).send(rows[0]);
    } catch (err) {
      if (isUniqueViolation(err)) throw new ArcError(409, 'model_exists', 'Model already exists');
      if ((err as { code?: string }).code === '23503') throw notFound('Provider');
      throw err;
    }
  });

  app.patch('/models/:id', async (req) => {
    const user = requireSuperadmin(req);
    const { id } = parseInput(idParam, req.params);
    const body = parseInput(updateModelSchema, req.body);

    const current = await db.query<{
      eligibility: string;
      enabled: boolean;
      eligibility_evidence_url: string | null;
    }>('SELECT eligibility, enabled, eligibility_evidence_url FROM models WHERE id = $1', [id]);
    const existing = current.rows[0];
    if (!existing) throw notFound('Model');

    const eligibility = body.eligibility ?? existing.eligibility;
    const eligibilityChanged =
      body.eligibility !== undefined && body.eligibility !== existing.eligibility;
    if (eligibilityChanged && eligibility !== 'UNKNOWN' && !body.eligibilityEvidenceUrl) {
      throw new ArcError(
        400,
        'evidence_required',
        'eligibilityEvidenceUrl is required to classify a model',
      );
    }
    const enabled = eligibility === 'UNKNOWN' ? false : (body.enabled ?? existing.enabled);
    if (body.enabled === true && eligibility === 'UNKNOWN') {
      throw new ArcError(
        400,
        'eligibility_unknown',
        'A model with UNKNOWN eligibility cannot be enabled',
      );
    }
    const evidenceUrl =
      eligibility === 'UNKNOWN'
        ? null
        : (body.eligibilityEvidenceUrl ?? existing.eligibility_evidence_url);
    const touchEvidence =
      eligibility !== 'UNKNOWN' &&
      (eligibilityChanged || body.eligibilityEvidenceUrl !== undefined);

    const { rows } = await db.query(
      `UPDATE models SET
         display_name = CASE WHEN $2 THEN $3 ELSE display_name END,
         capabilities = COALESCE($4, capabilities),
         eligibility = $5,
         eligibility_evidence_url = $6,
         eligibility_checked_at = CASE WHEN $5 = 'UNKNOWN' THEN NULL
                                       WHEN $7 THEN now() ELSE eligibility_checked_at END,
         enabled = $8,
         terms_note = CASE WHEN $9 THEN nullif($10, '') ELSE terms_note END,
         updated_at = now()
       WHERE id = $1 RETURNING ${MODEL_COLUMNS}`,
      [
        id,
        body.displayName !== undefined,
        body.displayName ?? null,
        body.capabilities ?? null,
        eligibility,
        evidenceUrl,
        touchEvidence,
        enabled,
        body.termsNote !== undefined,
        body.termsNote ?? null,
      ],
    );
    await recordAudit(db, {
      tenantId: null,
      actorUserId: user.userId,
      action: 'model.updated',
      targetType: 'model',
      targetId: id,
      metadata: { fields: Object.keys(body), eligibility, enabled },
    });
    return rows[0];
  });
}
