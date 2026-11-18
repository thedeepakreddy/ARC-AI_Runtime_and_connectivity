import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Db, withTransaction } from './pool.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));
const MIGRATION_LOCK_ID = 7_041_990_001;

/**
 * Apply pending SQL migrations in filename order. Each file runs in its own
 * transaction under an advisory lock, so concurrent instances cannot race.
 */
export async function migrate(db: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const applied: string[] = [];

  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    const sql = await readFile(path.join(dir, file), 'utf8');
    const ran = await withTransaction(db, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID]);
      const done = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [
        version,
      ]);
      if (done.rowCount) return false;
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      return true;
    });
    if (ran) applied.push(version);
  }
  return applied;
}
