import { createHash, randomBytes } from 'node:crypto';
import type { Queryable } from '../db/pool.js';

export type TokenPurpose = 'password_reset' | 'email_verify' | 'mfa_login' | 'oauth_state';

const PREFIX: Record<TokenPurpose, string> = {
  password_reset: 'arcr_',
  email_verify: 'arcv_',
  mfa_login: 'arcm_',
  oauth_state: 'arco_',
};

export const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest();

export interface TokenRow {
  id: string;
  user_id: string | null;
  data: Record<string, unknown>;
  attempts: number;
}

/** Create a one-time token; only its SHA-256 is stored. Returns the raw token (shown once). */
export async function issueToken(
  q: Queryable,
  args: {
    purpose: TokenPurpose;
    userId: string | null;
    ttlMs: number;
    data?: Record<string, unknown>;
  },
): Promise<string> {
  const token = PREFIX[args.purpose] + randomBytes(32).toString('base64url');
  // Older unused tokens of the same kind for this user stop working.
  if (args.userId && args.purpose !== 'mfa_login') {
    await q.query(
      `UPDATE auth_tokens SET used_at = now()
        WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`,
      [args.userId, args.purpose],
    );
  }
  await q.query(
    `INSERT INTO auth_tokens (user_id, purpose, token_hash, data, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))`,
    [args.userId, args.purpose, hashToken(token), args.data ?? {}, args.ttlMs / 1000],
  );
  return token;
}

/** A live (unused, unexpired) token of this purpose, or null. Does not use it up. */
export async function findToken(
  q: Queryable,
  token: string,
  purpose: TokenPurpose,
): Promise<TokenRow | null> {
  if (!token.startsWith(PREFIX[purpose]) || token.length > 100) return null;
  const { rows } = await q.query<TokenRow>(
    `SELECT id, user_id, data, attempts FROM auth_tokens
      WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()`,
    [hashToken(token), purpose],
  );
  return rows[0] ?? null;
}

/** Use a token up. Returns false if it was already used (a race lost). */
export async function spendToken(q: Queryable, id: string): Promise<boolean> {
  const r = await q.query(
    'UPDATE auth_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL',
    [id],
  );
  return (r.rowCount ?? 0) > 0;
}
