import { recordAudit } from '../audit.js';
import { type Db, withTransaction } from '../db/pool.js';
import type { CredentialService } from '../vault/credentials.js';
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
