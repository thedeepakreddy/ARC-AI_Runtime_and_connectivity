import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import { type Db, withTransaction } from '../db/pool.js';
import { ArcError, parseInput } from '../errors.js';
import { END_USER_HEADER, endUserHash } from '../inference/end-users.js';
import type { ApiKeyPrincipal, Scope } from '../keys/verifier.js';
import type { ProviderProbe } from '../providers/probe.js';
import { validateAccount } from '../providers/validation.js';
import type { CredentialService } from '../vault/credentials.js';

export interface UserKeyDeps {
  db: Db;
  credentials: CredentialService;
  probe: ProviderProbe;
  probeTimeoutMs: number;
  /** Drop cached routing so a new or removed key takes effect at once. */
  onChange?: () => void;
}

const providerParam = z.object({ provider: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/) });
const putBody = z.object({ apiKey: z.string().trim().min(8).max(4096) });

/**
 * End users' own provider keys, managed by the app on their behalf: the app's ARC key proves the
 * app, X-ARC-User names the user. ARC stores the key in its vault (never the app), scoped to this
 * app and this user, and uses it only for that user's requests. Keys are never returned, only
 * their last characters.
 *
 *   GET    /v1/user-keys              the user's keys (provider, hint, health)
 *   PUT    /v1/user-keys/:provider    { apiKey } — add or replace, checked with the provider
 *   DELETE /v1/user-keys/:provider
 */
export function userKeyRoutes(
  app: FastifyInstance,
  deps: UserKeyDeps,
  requireScope: (req: FastifyRequest, scope: Scope) => ApiKeyPrincipal,
): void {
  const { db, credentials } = deps;

  function who(req: FastifyRequest) {
    const principal = requireScope(req, 'inference');
    const hash = endUserHash(req, principal.applicationId);
    if (!hash) {
      throw new ArcError(400, 'end_user_required', `Send ${END_USER_HEADER} with the user's id`);
    }
    return { principal, hash };
  }

  app.get('/user-keys', async (req) => {
    const { principal, hash } = who(req);
    const { rows } = await db.query(
      `SELECT a.provider_id AS provider, c.secret_hint AS hint, a.health_status AS health,
              a.last_validated_at AS "lastValidatedAt", a.created_at AS "createdAt"
         FROM provider_accounts a JOIN credentials c ON c.id = a.credential_id
        WHERE a.scope = 'end_user' AND a.application_id = $1 AND a.end_user_hash = $2
        ORDER BY a.provider_id`,
      [principal.applicationId, hash],
    );
    return { data: rows };
  });

  app.put('/user-keys/:provider', async (req) => {
    const { principal, hash } = who(req);
    const { provider } = parseInput(providerParam, req.params);
    const { apiKey } = parseInput(putBody, req.body);
    const p = await db.query<{
      adapter: 'litellm_native' | 'openai_compatible';
      default_base_url: string | null;
    }>('SELECT adapter, default_base_url FROM providers WHERE id = $1', [provider]);
    const prov = p.rows[0];
    if (!prov) throw new ArcError(404, 'not_found', 'Unknown provider');
    // Self-hosted and custom endpoints need a base URL: not something end users register.
    if (!prov.default_base_url) {
      throw new ArcError(400, 'unsupported_provider', 'This provider needs a server address');
    }

    const accountId = await withTransaction(db, async (tx) => {
      const existing = await tx.query<{ id: string; credential_id: string }>(
        `SELECT id, credential_id FROM provider_accounts
          WHERE scope = 'end_user' AND application_id = $1 AND end_user_hash = $2
            AND provider_id = $3 FOR UPDATE`,
        [principal.applicationId, hash, provider],
      );
      const cred = await credentials.store(tx, principal.tenantId, apiKey);
      let id: string;
      if (existing.rows[0]) {
        id = existing.rows[0].id;
        await tx.query(
          `UPDATE provider_accounts SET credential_id = $2, health_status = 'unknown',
                  last_validation_error = NULL, enabled = true, updated_at = now() WHERE id = $1`,
          [id, cred.id],
        );
        await credentials.remove(tx, principal.tenantId, existing.rows[0].credential_id);
      } else {
        const r = await tx.query<{ id: string }>(
          `INSERT INTO provider_accounts
             (tenant_id, provider_id, label, scope, credential_id, application_id, end_user_hash)
           VALUES ($1, $2, $3, 'end_user', $4, $5, $6) RETURNING id`,
          [
            principal.tenantId,
            provider,
            // Unique per tenant and provider; carries no user data.
            `end user ${hash.slice(0, 24)}`,
            cred.id,
            principal.applicationId,
            hash,
          ],
        );
        id = r.rows[0]!.id;
      }
      await recordAudit(tx, {
        tenantId: principal.tenantId,
        actorUserId: null,
        action: existing.rows[0] ? 'end_user_key.replaced' : 'end_user_key.added',
        targetType: 'provider_account',
        targetId: id,
        metadata: { providerId: provider, applicationId: principal.applicationId },
      });
      return id;
    });

    const cred = await db.query<{ credential_id: string; secret_hint: string }>(
      `SELECT a.credential_id, c.secret_hint FROM provider_accounts a
         JOIN credentials c ON c.id = a.credential_id WHERE a.id = $1`,
      [accountId],
    );
    const outcome = await validateAccount(
      db,
      credentials,
      deps.probe,
      {
        id: accountId,
        tenantId: principal.tenantId,
        providerId: provider,
        adapter: prov.adapter,
        credentialId: cred.rows[0]!.credential_id,
        baseUrl: null,
        defaultBaseUrl: prov.default_base_url,
      },
      deps.probeTimeoutMs,
      null,
    );
    deps.onChange?.();
    return {
      provider,
      hint: cred.rows[0]!.secret_hint,
      health: outcome.status,
      modelsSeen: outcome.modelsSeen,
      error: outcome.error,
    };
  });

  app.delete('/user-keys/:provider', async (req, reply) => {
    const { principal, hash } = who(req);
    const { provider } = parseInput(providerParam, req.params);
    const removed = await withTransaction(db, async (tx) => {
      const r = await tx.query<{ id: string; credential_id: string }>(
        `DELETE FROM provider_accounts
          WHERE scope = 'end_user' AND application_id = $1 AND end_user_hash = $2
            AND provider_id = $3
        RETURNING id, credential_id`,
        [principal.applicationId, hash, provider],
      );
      const row = r.rows[0];
      if (!row) return false;
      await credentials.remove(tx, principal.tenantId, row.credential_id);
      await recordAudit(tx, {
        tenantId: principal.tenantId,
        actorUserId: null,
        action: 'end_user_key.removed',
        targetType: 'provider_account',
        targetId: row.id,
        metadata: { providerId: provider, applicationId: principal.applicationId },
      });
      return true;
    });
    if (!removed) throw new ArcError(404, 'not_found', 'No key for this provider');
    deps.onChange?.();
    return reply.code(204).send();
  });
}
