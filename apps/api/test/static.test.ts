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

describe('serving the website', () => {
  const site = mkdtempSync(path.join(tmpdir(), 'arc-site-'));
  mkdirSync(path.join(site, 'site-assets'));
  writeFileSync(path.join(site, 'index.html'), '<!doctype html><title>ARC</title>');
  writeFileSync(path.join(site, 'site-assets', 'index-AbCdEf12.js'), 'console.log(2)');
  writeFileSync(path.join(site, 'site-assets', 'earth_day_4096-DkcerPt2.jpg'), 'jpg');
  writeFileSync(path.join(site, 'site-assets', 'favicon-32.png'), 'png');
  mkdirSync(path.join(site, 'site-assets', 'earth'));
  writeFileSync(path.join(site, 'site-assets', 'earth', 'earth_day_2048.jpg'), 'jpg');
  const app = buildApp({ checks: [], readinessTimeoutMs: 100, siteDir: site });
  afterAll(async () => {
    await app.close();
  });

  it('serves the page at / with the strict policy', async () => {
    const r = await app.inject({ method: 'GET', url: '/' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('<title>ARC</title>');
    expect(r.headers['content-security-policy']).toContain("script-src 'self'");
    expect(r.headers['cache-control']).toBe('no-cache');
  });

  it('serves its assets, hashed ones for a year, and nothing outside them', async () => {
    const js = await app.inject({ method: 'GET', url: '/site-assets/index-AbCdEf12.js' });
    expect(js.body).toBe('console.log(2)');
    expect(js.headers['cache-control']).toContain('immutable');
    const png = await app.inject({ method: 'GET', url: '/site-assets/favicon-32.png' });
    expect(png.headers['cache-control']).toBe('no-cache');
    const hashedMap = await app.inject({
      method: 'GET',
      url: '/site-assets/earth_day_4096-DkcerPt2.jpg',
    });
    expect(hashedMap.headers['content-type']).toBe('image/jpeg');
    expect(hashedMap.headers['cache-control']).toContain('immutable');
    const map = await app.inject({ method: 'GET', url: '/site-assets/earth/earth_day_2048.jpg' });
    expect(map.statusCode).toBe(200);
    expect(map.headers['cache-control']).toContain('max-age=86400');
    expect(
      (await app.inject({ method: 'GET', url: '/site-assets/../index.html' })).statusCode,
    ).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/site-assets/missing.js' })).statusCode).toBe(
      404,
    );
    // Unknown paths elsewhere are not swallowed by the site.
    expect((await app.inject({ method: 'GET', url: '/nope' })).statusCode).toBe(404);
  });
});
