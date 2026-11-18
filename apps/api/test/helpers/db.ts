import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { syncProviderCatalogue } from '../../src/catalogue/providers.js';
import { migrate } from '../../src/db/migrate.js';
import { type Db, createPool } from '../../src/db/pool.js';

/** Base URL of a Postgres the tests may create databases on. Tests skip when unset. */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** Create an isolated, migrated database for one test file. */
export async function createTestDatabase(): Promise<{ db: Db; drop: () => Promise<void> }> {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set');
  const name = `arc_t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const db = createPool(url.toString());
  await migrate(db);
  await syncProviderCatalogue(db);

  return {
    db,
    async drop() {
      await db.end();
      const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}
