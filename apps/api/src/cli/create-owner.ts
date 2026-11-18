/**
 * Create the platform owner (superadmin). Reads ARC_OWNER_EMAIL and ARC_OWNER_PASSWORD
 * from the environment so the password never appears in shell history or process args.
 */
import { createOwner } from '../auth/owner.js';
import { migrate } from '../db/migrate.js';
import { createPool } from '../db/pool.js';
import { ArcError } from '../errors.js';

const url = process.env.DATABASE_URL;
const email = process.env.ARC_OWNER_EMAIL;
const password = process.env.ARC_OWNER_PASSWORD;
if (!url || !email || !password) {
  console.error('DATABASE_URL, ARC_OWNER_EMAIL and ARC_OWNER_PASSWORD are required');
  process.exit(1);
}
const db = createPool(url);
try {
  await migrate(db);
  const { userId } = await createOwner(db, { email, password });
  console.log(`owner created: ${userId}`);
} catch (err) {
  console.error(err instanceof ArcError ? err.message : 'failed to create owner');
  process.exitCode = 1;
} finally {
  await db.end();
}
