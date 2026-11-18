import type { Queryable } from './db/pool.js';

export interface AuditEvent {
  tenantId: string | null;
  actorUserId: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  /** Metadata only. Never secrets, prompts or responses. */
  metadata?: Record<string, unknown>;
}

export async function recordAudit(q: Queryable, e: AuditEvent): Promise<void> {
  await q.query(
    `INSERT INTO audit_events (tenant_id, actor_user_id, action, target_type, target_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      e.tenantId,
      e.actorUserId,
      e.action,
      e.targetType ?? null,
      e.targetId ?? null,
      e.metadata ?? {},
    ],
  );
}
