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
 * Serves a built single-page app (the owner console at /console, the customer dashboard at
 * /dashboard). Unknown paths get index.html (the app routes in the browser). Hashed assets are
 * cached for a year; index.html never.
 */
export function serveApp(app: FastifyInstance, mount: string, dir: string): void {
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
    const body = await readFile(file).catch(() => null);
    if (!body) return reply.code(404).send();
    return reply
      .headers({
        'content-type': TYPES[ext] ?? 'application/octet-stream',
        'cache-control':
          rel.startsWith('assets/') && isFile ? 'public, max-age=31536000, immutable' : 'no-cache',
        'content-security-policy': CSP,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'x-frame-options': 'DENY',
      })
      .send(body);
  });
}
