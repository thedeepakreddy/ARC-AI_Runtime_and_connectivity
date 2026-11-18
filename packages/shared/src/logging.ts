/**
 * Log paths that must never be written in clear text.
 * ARC logs metadata only: no secrets, prompts, responses or file contents.
 */
export const REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["proxy-authorization"]',
  'res.headers["set-cookie"]',
  '*.apiKey',
  '*.api_key',
  '*.password',
  '*.secret',
  '*.token',
];

export const REDACTED = '[REDACTED]';
