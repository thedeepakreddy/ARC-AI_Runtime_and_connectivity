import { randomUUID } from 'node:crypto';
import type { Db, Queryable } from '../db/pool.js';
import { notFound } from '../errors.js';
import {
  type KeyRing,
  type SealedSecret,
  decryptSecret,
  encryptSecret,
  rewrapSecret,
  secretHint,
} from './vault.js';

const binding = (tenantId: string, credentialId: string) => `${tenantId}:${credentialId}`;

interface CredentialRow {
  id: string;
  tenant_id: string;
  kek_version: number;
  wrapped_dek: Buffer;
  ciphertext: Buffer;
}

const toSealed = (r: CredentialRow): SealedSecret => ({
  kekVersion: r.kek_version,
  wrappedDek: r.wrapped_dek,
  ciphertext: r.ciphertext,
});

/**
 * The only component that holds vault keys. Plaintext secrets leave it only through
 * `reveal`, for use in provider calls; they are never returned to API clients.
 */
export class CredentialService {
  constructor(private readonly ring: KeyRing) {}

  async store(
    q: Queryable,
    tenantId: string,
    secret: string,
  ): Promise<{ id: string; hint: string }> {
    const id = randomUUID();
    const sealed = encryptSecret(this.ring, secret, binding(tenantId, id));
    const hint = secretHint(secret);
    await q.query(
      `INSERT INTO credentials (id, tenant_id, kek_version, wrapped_dek, ciphertext, secret_hint)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, tenantId, sealed.kekVersion, sealed.wrappedDek, sealed.ciphertext, hint],
    );
    return { id, hint };
  }

  async reveal(q: Queryable, tenantId: string, credentialId: string): Promise<string> {
    const { rows } = await q.query<CredentialRow>(
      'SELECT * FROM credentials WHERE id = $1 AND tenant_id = $2',
      [credentialId, tenantId],
    );
    const row = rows[0];
    if (!row) throw notFound('Credential');
    return decryptSecret(this.ring, toSealed(row), binding(row.tenant_id, row.id));
  }

  async remove(q: Queryable, tenantId: string, credentialId: string): Promise<void> {
    await q.query('DELETE FROM credentials WHERE id = $1 AND tenant_id = $2', [
      credentialId,
      tenantId,
    ]);
  }

  /** Re-wrap every data key under the current KEK version. Returns rows updated. */
  async rewrapAll(db: Db): Promise<number> {
    const { rows } = await db.query<CredentialRow>(
      'SELECT * FROM credentials WHERE kek_version <> $1',
      [this.ring.current],
    );
    for (const row of rows) {
      const next = rewrapSecret(this.ring, toSealed(row), binding(row.tenant_id, row.id));
      await db.query(
        'UPDATE credentials SET kek_version = $1, wrapped_dek = $2 WHERE id = $3 AND kek_version = $4',
        [next.kekVersion, next.wrappedDek, row.id, row.kek_version],
      );
    }
    return rows.length;
  }
}
