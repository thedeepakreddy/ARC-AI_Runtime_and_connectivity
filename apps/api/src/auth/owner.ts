import { z } from 'zod';
import { recordAudit } from '../audit.js';
import { type Db, withTransaction } from '../db/pool.js';
import { ArcError } from '../errors.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, hashPassword } from './password.js';

export const ownerInputSchema = z.object({
  email: z.email().max(320),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  tenantName: z.string().min(1).max(200).default('ARC Platform'),
});

/**
 * Create the platform tenant and its superadmin owner. Runs once; refuses if a
 * platform tenant already exists.
 */
export async function createOwner(
  db: Db,
  input: z.input<typeof ownerInputSchema>,
): Promise<{ userId: string; tenantId: string }> {
  const parsed = ownerInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ArcError(
      400,
      'invalid_owner',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  const { email, password, tenantName } = parsed.data;
  const passwordHash = await hashPassword(password);

  return withTransaction(db, async (tx) => {
    const existing = await tx.query("SELECT 1 FROM tenants WHERE kind = 'platform'");
    if (existing.rowCount)
      throw new ArcError(409, 'owner_exists', 'The platform owner already exists');
    const tenant = await tx.query<{ id: string }>(
      "INSERT INTO tenants (kind, name) VALUES ('platform', $1) RETURNING id",
      [tenantName],
    );
    const user = await tx.query<{ id: string }>(
      'INSERT INTO users (email, password_hash, is_superadmin) VALUES ($1, $2, true) RETURNING id',
      [email, passwordHash],
    );
    const tenantId = tenant.rows[0]!.id;
    const userId = user.rows[0]!.id;
    await tx.query("INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')", [
      tenantId,
      userId,
    ]);
    await recordAudit(tx, { tenantId, actorUserId: userId, action: 'platform.owner_created' });
    return { userId, tenantId };
  });
}
