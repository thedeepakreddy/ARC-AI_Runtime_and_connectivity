/** Re-wrap every credential's data key under the current vault key version. */
import { createPool } from '../db/pool.js';
import { CredentialService } from '../vault/credentials.js';
import { loadKeyRing } from '../vault/vault.js';

const url = process.env.DATABASE_URL;
const keyFile = process.env.ARC_VAULT_KEY_FILE;
if (!url || !keyFile) {
  console.error('DATABASE_URL and ARC_VAULT_KEY_FILE are required');
  process.exit(1);
}
const db = createPool(url);
try {
  const count = await new CredentialService(loadKeyRing(keyFile)).rewrapAll(db);
  console.log(`re-wrapped ${count} credential(s)`);
} finally {
  await db.end();
}
