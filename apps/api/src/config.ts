import { baseEnvSchema, parseEnv } from '@arc/shared';
import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

export const apiEnvSchema = baseEnvSchema.extend({
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  LITELLM_BASE_URL: z.url(),
  /** Per-dependency timeout for readiness checks; readiness must never hang. */
  READINESS_TIMEOUT_MS: z.coerce.number().int().min(50).max(10_000).default(1000),
  /** Path to the versioned vault key file. Must live outside PostgreSQL. */
  ARC_VAULT_KEY_FILE: z.string().min(1),
  SESSION_TTL_HOURS: z.coerce
    .number()
    .min(1)
    .max(24 * 30)
    .default(12),
  /** Secure cookies require HTTPS. Defaults to true outside development/test. */
  COOKIE_SECURE: bool.optional(),
  /** Set when running behind a reverse proxy that sets X-Forwarded-For. */
  TRUST_PROXY: bool.default(false),
  MIGRATE_ON_START: bool.default(true),
  PROBE_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5000),
});

export type ApiConfig = z.infer<typeof apiEnvSchema>;

export function loadConfig(source: Record<string, string | undefined> = process.env): ApiConfig {
  return parseEnv(apiEnvSchema, source);
}

export function cookieSecure(config: ApiConfig): boolean {
  return config.COOKIE_SECURE ?? config.NODE_ENV === 'production';
}
