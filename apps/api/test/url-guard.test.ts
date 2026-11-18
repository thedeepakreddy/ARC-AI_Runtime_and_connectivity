import { describe, expect, it } from 'vitest';
import { assertPublicHttpsUrl, isBlockedAddress } from '../src/providers/url-guard.js';

const resolveTo =
  (...addrs: string[]) =>
  async () =>
    addrs;

describe('SSRF URL guard', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.5',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '0.0.0.0',
  ])('blocks %s', (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '::ffff:8.8.8.8', '2606:4700:4700::1111'])(
    'allows public %s',
    (ip) => expect(isBlockedAddress(ip)).toBe(false),
  );

  it('rejects http, private resolution, and mixed answers', async () => {
    await expect(
      assertPublicHttpsUrl('http://api.example.com/v1', resolveTo('8.8.8.8')),
    ).rejects.toThrow(/https/);
    await expect(
      assertPublicHttpsUrl('https://internal.example.com', resolveTo('10.0.0.5')),
    ).rejects.toThrow(/public/);
    await expect(
      assertPublicHttpsUrl('https://mixed.example.com', resolveTo('8.8.8.8', '127.0.0.1')),
    ).rejects.toThrow(/public/);
    await expect(assertPublicHttpsUrl('https://169.254.169.254/latest')).rejects.toThrow(/public/);
  });

  it('accepts a public https URL', async () => {
    await expect(
      assertPublicHttpsUrl('https://api.example.com/v1', resolveTo('8.8.4.4')),
    ).resolves.toBeUndefined();
  });
});
