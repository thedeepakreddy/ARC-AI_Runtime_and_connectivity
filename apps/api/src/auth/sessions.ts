import { createHash, randomBytes } from 'node:crypto';
import type { Queryable } from '../db/pool.js';

export const SESSION_COOKIE = 'arc_session';
const TOKEN_PREFIX = 'arcs_';

export interface SessionUser {
  sessionId: string;
  userId: string;
  email: string;
  isSuperadmin: boolean;
}

const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest();

/** Create a session and return the opaque token. Only its SHA-256 is stored. */
export async function createSession(
  q: Queryable,
  userId: string,
  ttlMs: number,
  userAgent: string | undefined,
): Promise<string> {
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
  await q.query(
    `INSERT INTO sessions (user_id, token_hash, user_agent, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
    [userId, hashToken(token), userAgent?.slice(0, 300) ?? null, ttlMs / 1000],
  );
  return token;
}

export async function resolveSession(q: Queryable, token: string): Promise<SessionUser | null> {
  if (!token.startsWith(TOKEN_PREFIX) || token.length > 100) return null;
  const { rows } = await q.query<{
    session_id: string;
    user_id: string;
    email: string;
    is_superadmin: boolean;
  }>(
    `SELECT s.id AS session_id, u.id AS user_id, u.email, u.is_superadmin
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
        AND u.disabled_at IS NULL`,
    [hashToken(token)],
  );
  const row = rows[0];
  return row
    ? {
        sessionId: row.session_id,
        userId: row.user_id,
        email: row.email,
        isSuperadmin: row.is_superadmin,
      }
    : null;
}

export async function revokeSession(q: Queryable, sessionId: string): Promise<void> {
  await q.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [
    sessionId,
  ]);
}
