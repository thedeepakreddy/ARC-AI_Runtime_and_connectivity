import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * ARC API key format: ARC_DEE_<key id>_PAK_<secret>
 *
 * - key id: 12 random bytes, base62 (17 chars). Non-secret lookup handle.
 * - secret: 32 random bytes (256 bits), base62 (43 chars). Only its SHA-256 is stored.
 * "DEE" and "PAK" are fixed, visible identifiers, not secrets. Base62 keeps the key URL-safe
 * and free of the "_" separator.
 */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const KEY_ID_BYTES = 12;
const SECRET_BYTES = 32;
const KEY_ID_LENGTH = 17;
const SECRET_LENGTH = 43;
const PATTERN = /^ARC_DEE_([0-9A-Za-z]{17})_PAK_([0-9A-Za-z]{43})$/;

function base62(bytes: Buffer, length: number): string {
  let n = BigInt(`0x${bytes.toString('hex')}`);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out.padStart(length, '0');
}

export interface GeneratedKey {
  /** Full key. Shown to the user exactly once, never stored. */
  key: string;
  keyId: string;
  secretHash: Buffer;
  /** Safe to display: id plus the last 4 characters of the secret. */
  displayPrefix: string;
}

export const hashSecret = (secret: string): Buffer =>
  createHash('sha256').update(secret, 'utf8').digest();

export function generateArcKey(): GeneratedKey {
  const keyId = base62(randomBytes(KEY_ID_BYTES), KEY_ID_LENGTH);
  const secret = base62(randomBytes(SECRET_BYTES), SECRET_LENGTH);
  return {
    key: `ARC_DEE_${keyId}_PAK_${secret}`,
    keyId,
    secretHash: hashSecret(secret),
    displayPrefix: `ARC_DEE_${keyId}_PAK_…${secret.slice(-4)}`,
  };
}

export function parseArcKey(token: string): { keyId: string; secret: string } | null {
  if (token.length > 100) return null;
  const m = PATTERN.exec(token);
  return m ? { keyId: m[1]!, secret: m[2]! } : null;
}

export function secretMatches(secret: string, storedHash: Buffer): boolean {
  const actual = hashSecret(secret);
  return actual.length === storedHash.length && timingSafeEqual(actual, storedHash);
}
