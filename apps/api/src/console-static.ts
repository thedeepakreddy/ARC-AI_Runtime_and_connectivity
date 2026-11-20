import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.webp': 'image/webp',
};

// Same origin as /admin/v1, so the SameSite=Strict session cookie just works. Nothing third-party.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

/**
 * With Google ads (dashboard only, when AdSense is configured): Google's recommended strict CSP.
 * Scripts run only with this response's nonce, or when loaded by a script that has it
 * ('strict-dynamic'), which is how the AdSense loader brings its own; the https:/'unsafe-inline'
 * entries are ignored by browsers that understand nonces (fallbacks for old ones). Ads render in
 * Google's frames and need inline styles and images from anywhere.
 */
const adsCsp = (nonce: string) =>
  [
    "default-src 'self'",
    `script-src 'nonce-${nonce}' 'strict-dynamic' https: 'unsafe-inline'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self'",
    "connect-src 'self' https:",
    'frame-src https:',
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');

/**
 * Serves a built single-page app (the owner console at /console, the customer dashboard at
 * /dashboard). Unknown paths get index.html (the app routes in the browser). Hashed assets are
 * cached for a year; index.html never.
 */
export function serveApp(
  app: FastifyInstance,
  mount: string,
  dir: string,
  opts: { ads?: boolean } = {},
): void {
  const root = path.resolve(dir);
  app.get(mount, (_req, reply) => reply.redirect(`${mount}/`));
  app.get(`${mount}/*`, async (req, reply) => {
    const rel = decodeURIComponent((req.params as { '*': string })['*'] ?? '');
    let file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep) && file !== root) return reply.code(404).send();
    const isFile = await stat(file).then(
      (s) => s.isFile(),
      () => false,
    );
    if (!isFile) file = path.join(root, 'index.html');
    const ext = path.extname(file);
    let body: Buffer | string | null = await readFile(file).catch(() => null);
    if (!body) return reply.code(404).send();
    let csp = CSP;
    if (opts.ads && ext === '.html') {
      const nonce = randomBytes(16).toString('base64');
      csp = adsCsp(nonce);
      body = body.toString('utf8').replaceAll('<script ', `<script nonce="${nonce}" `);
    }
    return reply
      .headers({
        'content-type': TYPES[ext] ?? 'application/octet-stream',
        'cache-control':
          rel.startsWith('assets/') && isFile ? 'public, max-age=31536000, immutable' : 'no-cache',
        'content-security-policy': csp,
        'x-content-type-options': 'nosniff',
        // With ads, the origin only (ad networks check the site); never paths or fragments.
        'referrer-policy': opts.ads ? 'strict-origin' : 'no-referrer',
        'x-frame-options': 'DENY',
      })
      .send(body);
  });
}
