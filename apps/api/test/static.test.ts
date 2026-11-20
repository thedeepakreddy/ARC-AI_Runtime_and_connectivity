import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

const dir = mkdtempSync(path.join(tmpdir(), 'arc-static-'));
mkdirSync(path.join(dir, 'assets'));
writeFileSync(
  path.join(dir, 'index.html'),
  '<!doctype html><script type="module" crossorigin src="/dashboard/assets/a.js"></script>',
);
writeFileSync(path.join(dir, 'assets', 'a.js'), 'console.log(1)');

describe('serving the apps', () => {
  const plain = buildApp({ checks: [], readinessTimeoutMs: 100, dashboardDir: dir });
  const withAds = buildApp({
    checks: [],
    readinessTimeoutMs: 100,
    dashboardDir: dir,
    ads: { client: 'ca-pub-1234567890123456', slot: '1234567890' },
  });
  afterAll(async () => {
    await plain.close();
    await withAds.close();
  });

  it('without ads: scripts from ARC only, no referrer', async () => {
    const r = await plain.inject({ method: 'GET', url: '/dashboard/' });
    expect(r.headers['content-security-policy']).toContain("script-src 'self'");
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect((await plain.inject({ method: 'GET', url: '/ads.txt' })).statusCode).toBe(404);
  });

  it('with ads: a fresh nonce per page on every script, strict-dynamic, and ads.txt', async () => {
    const a = await withAds.inject({ method: 'GET', url: '/dashboard/apps' });
    const b = await withAds.inject({ method: 'GET', url: '/dashboard/apps' });
    const nonce = /'nonce-([^']+)'/.exec(String(a.headers['content-security-policy']))![1]!;
    expect(a.headers['content-security-policy']).toContain("'strict-dynamic'");
    expect(a.headers['content-security-policy']).toContain("object-src 'none'");
    expect(a.body).toContain(`<script nonce="${nonce}" type="module"`);
    expect(b.headers['content-security-policy']).not.toContain(nonce);
    expect(a.headers['referrer-policy']).toBe('strict-origin');
    // Hashed assets are served untouched.
    expect((await withAds.inject({ method: 'GET', url: '/dashboard/assets/a.js' })).body).toBe(
      'console.log(1)',
    );
    const txt = await withAds.inject({ method: 'GET', url: '/ads.txt' });
    expect(txt.body).toBe('google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0\n');
  });
});
