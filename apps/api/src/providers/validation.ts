import { recordAudit } from '../audit.js';
import { type Db, withTransaction } from '../db/pool.js';
import type { CredentialService } from '../vault/credentials.js';
import { suggestClassification } from '../catalogue/classify.js';
import type { ProbeResult, ProviderProbe } from './probe.js';

export interface AccountToValidate {
  id: string;
  tenantId: string;
  providerId: string;
  adapter: 'litellm_native' | 'openai_compatible';
  credentialId: string;
  baseUrl: string | null;
  defaultBaseUrl: string | null;
}

export interface ValidationOutcome {
  status: ProbeResult['status'];
  modelsSeen: number;
  error: string | null;
}

/**
 * Probe one provider key, store its health, and record the models it can see. Newly seen
 * models arrive as UNKNOWN and disabled. Used by the admin "validate" action and the worker.
 */
export async function validateAccount(
  db: Db,
  credentials: CredentialService,
  probe: ProviderProbe,
  account: AccountToValidate,
  timeoutMs: number,
  actorUserId: string | null,
): Promise<ValidationOutcome> {
  const secret = await credentials.reveal(db, account.tenantId, account.credentialId);
  const signal = AbortSignal.timeout(timeoutMs);
  const result = await probe.probe({
    providerId: account.providerId,
    adapter: account.adapter,
    baseUrl: account.baseUrl ?? account.defaultBaseUrl,
    apiKey: secret,
    signal,
  });

  let seen = 0;
  await withTransaction(db, async (tx) => {
    await tx.query(
      `UPDATE provider_accounts SET health_status = $3, last_validated_at = now(),
              last_validation_error = $4, updated_at = now()
        WHERE id = $1 AND tenant_id = $2`,
      [account.id, account.tenantId, result.status, result.error?.slice(0, 300) ?? null],
    );
    if (result.status === 'healthy') {
      for (const modelId of result.models) {
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO models (provider_id, model_id, source) VALUES ($1, $2, 'discovered')
           ON CONFLICT (provider_id, model_id) DO UPDATE SET updated_at = models.updated_at
           RETURNING id`,
          [account.providerId, modelId],
        );
        await tx.query(
          `INSERT INTO account_models (account_id, model_id) VALUES ($1, $2)
           ON CONFLICT (account_id, model_id) DO UPDATE SET seen_at = now()`,
          [account.id, rows[0]!.id],
        );
        // Automatic classification from the provider's own listing. Models the owner has
        // classified by hand keep the owner's choice; the suggestion is still recorded.
        const sg = suggestClassification(account.providerId, modelId, result.hints?.[modelId]);
        await tx.query(
          `UPDATE models SET
             suggestion = $2::jsonb,
             eligibility = CASE WHEN auto THEN $3 ELSE eligibility END,
             eligibility_evidence_url = CASE WHEN auto THEN $4 ELSE eligibility_evidence_url END,
             eligibility_checked_at = CASE WHEN auto AND $3 <> 'UNKNOWN'
                                             AND eligibility_evidence_url IS DISTINCT FROM $4
                                             THEN now()
                                           WHEN auto AND $3 = 'UNKNOWN' THEN NULL
                                           ELSE eligibility_checked_at END,
             capabilities = CASE WHEN auto THEN $5::text[] ELSE capabilities END,
             -- Turned on only the first time (a model the owner switched off stays off).
             enabled = CASE WHEN classified_by IS NULL THEN $6
                            WHEN auto AND $3 = 'UNKNOWN' THEN false ELSE enabled END,
             classified_by = CASE WHEN auto THEN 'auto' ELSE classified_by END
           FROM (SELECT classified_by IS DISTINCT FROM 'owner' AS auto FROM models WHERE id = $1) a
           WHERE models.id = $1`,
          [
            rows[0]!.id,
            JSON.stringify(sg),
            sg.eligibility,
            sg.evidenceUrl,
            sg.capabilities,
            sg.enable,
          ],
        );
        seen++;
      }
    }
    await recordAudit(tx, {
      tenantId: account.tenantId,
      actorUserId,
      action: actorUserId ? 'provider_account.validated' : 'provider_account.revalidated',
      targetType: 'provider_account',
      targetId: account.id,
      metadata: { status: result.status, models: seen },
    });
  });
  return { status: result.status, modelsSeen: seen, error: result.error ?? null };
}
