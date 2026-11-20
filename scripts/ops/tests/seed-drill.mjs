// Seeds a database with a tenant and an encrypted provider credential, so the restore drill in
// CI proves that credentials survive backup → restore → decrypt. Env: DATABASE_URL, ARC_VAULT_KEY_FILE.
import { createPool } from '../../../apps/api/dist/db/pool.js';
import { CredentialService } from '../../../apps/api/dist/vault/credentials.js';
import { loadKeyRing } from '../../../apps/api/dist/vault/vault.js';

const db = createPool(process.env.DATABASE_URL);
const credentials = new CredentialService(loadKeyRing(process.env.ARC_VAULT_KEY_FILE));
const { rows } = await db.query(
  "INSERT INTO tenants (kind, name) VALUES ('organization', 'Drill') RETURNING id",
);
for (let i = 0; i < 3; i++)
  await credentials.store(db, rows[0].id, `drill-provider-key-${i}-000000`);
await db.end();
console.log('seeded 3 credentials');
