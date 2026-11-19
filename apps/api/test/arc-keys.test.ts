import { describe, expect, it } from 'vitest';
import { generateArcKey, hashSecret, parseArcKey, secretMatches } from '../src/keys/arc-keys.js';
import { tamperLastChar } from './helpers/tamper.js';

describe('ARC API keys', () => {
  it('uses the ARC_DEE_<id>_PAK_<secret> format with a 256-bit secret', () => {
    const k = generateArcKey();
    expect(k.key).toMatch(/^ARC_DEE_[0-9A-Za-z]{17}_PAK_[0-9A-Za-z]{43}$/);
    const parsed = parseArcKey(k.key)!;
    expect(parsed.keyId).toBe(k.keyId);
    // 43 base62 chars carry >= 256 bits.
    expect(Math.log2(62) * parsed.secret.length).toBeGreaterThanOrEqual(256);
  });

  it('never repeats and stores only a hash', () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateArcKey().key));
    expect(keys.size).toBe(200);
    const k = generateArcKey();
    const secret = parseArcKey(k.key)!.secret;
    expect(k.secretHash.equals(hashSecret(secret))).toBe(true);
    expect(k.secretHash.toString('hex')).not.toContain(secret);
    expect(secretMatches(secret, k.secretHash)).toBe(true);
    expect(secretMatches(tamperLastChar(secret), k.secretHash)).toBe(false);
  });

  it('display prefix reveals only the id and last 4 secret characters', () => {
    const k = generateArcKey();
    const secret = parseArcKey(k.key)!.secret;
    expect(k.displayPrefix).toBe(`ARC_DEE_${k.keyId}_PAK_…${secret.slice(-4)}`);
    expect(k.displayPrefix).not.toContain(secret.slice(0, 20));
  });

  it.each([
    '',
    'sk-abc',
    'ARC_DEE_short_PAK_short',
    `ARC_XXX_${'a'.repeat(17)}_PAK_${'b'.repeat(43)}`,
    `ARC_DEE_${'a'.repeat(17)}_PAK_${'b'.repeat(43)}x`,
  ])('rejects malformed key %#', (token) => expect(parseArcKey(token)).toBeNull());
});
