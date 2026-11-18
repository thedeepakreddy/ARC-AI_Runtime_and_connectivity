import { describe, expect, it } from 'vitest';
import {
  VaultError,
  decryptSecret,
  encryptSecret,
  generateKeyFile,
  parseKeyRing,
  rewrapSecret,
  secretHint,
} from '../src/vault/vault.js';

describe('vault', () => {
  const ring = parseKeyRing(generateKeyFile());
  const secret = 'gsk_live_1234567890abcdef';

  it('round-trips a secret and never stores plaintext', () => {
    const sealed = encryptSecret(ring, secret, 'tenant-a:cred-1');
    expect(sealed.ciphertext.toString('utf8')).not.toContain(secret);
    expect(decryptSecret(ring, sealed, 'tenant-a:cred-1')).toBe(secret);
  });

  it('binds ciphertext to its row: a different binding fails', () => {
    const sealed = encryptSecret(ring, secret, 'tenant-a:cred-1');
    expect(() => decryptSecret(ring, sealed, 'tenant-b:cred-1')).toThrow(VaultError);
  });

  it('detects tampering', () => {
    const sealed = encryptSecret(ring, secret, 'b');
    const ct = Buffer.from(sealed.ciphertext);
    ct[ct.length - 1]! ^= 1;
    expect(() => decryptSecret(ring, { ...sealed, ciphertext: ct }, 'b')).toThrow(VaultError);
  });

  it('rotates: rewrap moves the data key to the new version, old data still decrypts', () => {
    const sealed = encryptSecret(ring, secret, 'b');
    const rotated = parseKeyRing(generateKeyFile(ring));
    expect(rotated.current).toBe(2);
    expect(decryptSecret(rotated, sealed, 'b')).toBe(secret);
    const rewrapped = rewrapSecret(rotated, sealed, 'b');
    expect(rewrapped.kekVersion).toBe(2);
    expect(decryptSecret(rotated, rewrapped, 'b')).toBe(secret);
  });

  it('rejects malformed key files without echoing contents', () => {
    expect(() => parseKeyRing('not json')).toThrow(VaultError);
    expect(() => parseKeyRing(JSON.stringify({ current: 1, keys: { '1': 'c2hvcnQ=' } }))).toThrow(
      /32 bytes/,
    );
    expect(() => parseKeyRing(JSON.stringify({ current: 2, keys: {} }))).toThrow(VaultError);
  });

  it('hints show only the last four characters', () => {
    expect(secretHint(secret)).toBe('****cdef');
    expect(secretHint('short')).toBe('****');
  });
});
