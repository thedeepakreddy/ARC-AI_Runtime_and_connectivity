/** Apply database migrations and sync the provider catalogue. Usage: arc-migrate */
import { syncProviderCatalogue } from '../catalogue/providers.js';
import { migrate } from '../db/migrate.js';
import { createPool } from '../db/pool.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const db = createPool(url);
try {
  const applied = await migrate(db);
  await syncProviderCatalogue(db);
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'database is up to date');
} finally {
  await db.end();
}
