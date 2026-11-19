/**
 * Verify a restored database against its source: schema version, per-table row counts, and
 * that every provider credential decrypts with the vault key file. Never prints secrets.
 * Env: SOURCE_DATABASE_URL, RESTORED_DATABASE_URL, ARC_VAULT_KEY_FILE.
 */
import { createPool } from '../db/pool.js';
import { CredentialService } from '../vault/credentials.js';
import { loadKeyRing } from '../vault/vault.js';

// Rows here change continuously on a live system; a count difference is reported, not fatal.
const VOLATILE = new Set([
  'route_observations',
  'route_scores',
  'worker_heartbeats',
  'audit_events',
  'sessions',
]);

const { SOURCE_DATABASE_URL, RESTORED_DATABASE_URL, ARC_VAULT_KEY_FILE } = process.env;
if (!SOURCE_DATABASE_URL || !RESTORED_DATABASE_URL || !ARC_VAULT_KEY_FILE) {
  console.error('SOURCE_DATABASE_URL, RESTORED_DATABASE_URL and ARC_VAULT_KEY_FILE are required');
  process.exit(1);
}
const source = createPool(SOURCE_DATABASE_URL);
const restored = createPool(RESTORED_DATABASE_URL);
const problems: string[] = [];

try {
  const versions = async (db: typeof source) =>
    (
      await db.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version')
    ).rows
      .map((r) => r.version)
      .join(',');
  const [sv, rv] = await Promise.all([versions(source), versions(restored)]);
  if (sv !== rv) problems.push(`schema version differs: source [${sv}] restored [${rv}]`);
  console.log(`schema migrations: ${rv}`);

  const { rows: tables } = await restored.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1",
  );
  for (const { table_name: t } of tables) {
    const count = async (db: typeof source) =>
      Number((await db.query(`SELECT count(*)::bigint AS n FROM "${t}"`)).rows[0].n);
    const [s, r] = await Promise.all([count(source), count(restored)]);
    const flag = s === r ? 'ok' : VOLATILE.has(t) ? 'changed (volatile)' : 'MISMATCH';
    if (flag === 'MISMATCH')
      problems.push(`row count mismatch in ${t}: source ${s}, restored ${r}`);
    console.log(
      `  ${t.padEnd(22)} source ${String(s).padStart(7)}  restored ${String(r).padStart(7)}  ${flag}`,
    );
  }

  const credentials = new CredentialService(loadKeyRing(ARC_VAULT_KEY_FILE));
  const { rows: creds } = await restored.query<{ id: string; tenant_id: string }>(
    'SELECT id, tenant_id FROM credentials',
  );
  let ok = 0;
  for (const c of creds) {
    try {
      await credentials.reveal(restored, c.tenant_id, c.id);
      ok++;
    } catch {
      /* counted below */
    }
  }
  console.log(`provider credentials decrypted: ${ok}/${creds.length}`);
  if (ok !== creds.length)
    problems.push(
      `${creds.length - ok} credential(s) could not be decrypted with this vault key file`,
    );
} finally {
  await Promise.allSettled([source.end(), restored.end()]);
}

if (problems.length) {
  for (const p of problems) console.error(`FAIL: ${p}`);
  process.exit(1);
}
console.log('verification passed');
