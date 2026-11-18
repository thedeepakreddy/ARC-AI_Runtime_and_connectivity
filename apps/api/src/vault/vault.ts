import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class VaultError extends Error {
  override readonly name = 'VaultError';
}

/** Versioned key-encryption keys. Never stored in PostgreSQL. */
export interface KeyRing {
  readonly current: number;
  readonly keys: ReadonlyMap<number, Buffer>;
}

const keyFileSchema = z.object({
  current: z.number().int().positive(),
  keys: z.record(z.string().regex(/^\d+$/), z.string()),
});

export function parseKeyRing(json: string): KeyRing {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new VaultError('vault key file is not valid JSON');
  }
  const parsed = keyFileSchema.safeParse(raw);
  if (!parsed.success) throw new VaultError('vault key file has an invalid shape');
  const keys = new Map<number, Buffer>();
  for (const [version, b64] of Object.entries(parsed.data.keys)) {
    const key = Buffer.from(b64, 'base64');
    if (key.length !== KEY_BYTES) {
      throw new VaultError(`vault key version ${version} must be ${KEY_BYTES} bytes`);
    }
    keys.set(Number(version), key);
  }
  if (!keys.has(parsed.data.current)) {
    throw new VaultError('vault key file: current version has no key');
  }
  return { current: parsed.data.current, keys };
}

export function loadKeyRing(filePath: string): KeyRing {
  return parseKeyRing(readFileSync(filePath, 'utf8'));
}

/** Produce a new key file, optionally adding a version to an existing ring (rotation). */
export function generateKeyFile(existing?: KeyRing): string {
  const keys: Record<string, string> = {};
  let next = 1;
  if (existing) {
    for (const [v, k] of existing.keys) keys[String(v)] = k.toString('base64');
    next = Math.max(...existing.keys.keys()) + 1;
  }
  keys[String(next)] = randomBytes(KEY_BYTES).toString('base64');
  return `${JSON.stringify({ current: next, keys }, null, 2)}\n`;
}

export interface SealedSecret {
  kekVersion: number;
  wrappedDek: Buffer;
  ciphertext: Buffer;
}

function seal(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

function open(key: Buffer, blob: Buffer, aad: string): Buffer {
  if (blob.length < IV_BYTES + TAG_BYTES) throw new VaultError('sealed blob is truncated');
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = blob.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new VaultError('decryption failed (wrong key or tampered data)');
  }
}

const dataAad = (binding: string) => `arc:data:${binding}`;
const dekAad = (binding: string, version: number) => `arc:dek:${binding}:v${version}`;

function kek(ring: KeyRing, version: number): Buffer {
  const key = ring.keys.get(version);
  if (!key) throw new VaultError(`vault key version ${version} is not loaded`);
  return key;
}

/**
 * Envelope-encrypt a secret. `binding` (e.g. tenant + credential id) is authenticated
 * as AAD, so a ciphertext copied to another row fails to decrypt.
 */
export function encryptSecret(ring: KeyRing, plaintext: string, binding: string): SealedSecret {
  const dek = randomBytes(KEY_BYTES);
  try {
    return {
      kekVersion: ring.current,
      wrappedDek: seal(kek(ring, ring.current), dek, dekAad(binding, ring.current)),
      ciphertext: seal(dek, Buffer.from(plaintext, 'utf8'), dataAad(binding)),
    };
  } finally {
    dek.fill(0);
  }
}

export function decryptSecret(ring: KeyRing, sealed: SealedSecret, binding: string): string {
  const dek = open(
    kek(ring, sealed.kekVersion),
    sealed.wrappedDek,
    dekAad(binding, sealed.kekVersion),
  );
  try {
    return open(dek, sealed.ciphertext, dataAad(binding)).toString('utf8');
  } finally {
    dek.fill(0);
  }
}

/** Re-wrap the data key under the current KEK (key rotation); ciphertext is unchanged. */
export function rewrapSecret(ring: KeyRing, sealed: SealedSecret, binding: string): SealedSecret {
  if (sealed.kekVersion === ring.current) return sealed;
  const dek = open(
    kek(ring, sealed.kekVersion),
    sealed.wrappedDek,
    dekAad(binding, sealed.kekVersion),
  );
  try {
    return {
      kekVersion: ring.current,
      wrappedDek: seal(kek(ring, ring.current), dek, dekAad(binding, ring.current)),
      ciphertext: sealed.ciphertext,
    };
  } finally {
    dek.fill(0);
  }
}

/** Short, non-reversible hint for UIs: last 4 characters only. */
export function secretHint(secret: string): string {
  return secret.length <= 8 ? '****' : `****${secret.slice(-4)}`;
}
