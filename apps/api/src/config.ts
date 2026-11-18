import { baseEnvSchema, parseEnv } from '@arc/shared';
import { z } from 'zod';

export const apiEnvSchema = baseEnvSchema.extend({
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  LITELLM_BASE_URL: z.url(),
  /** Per-dependency timeout for readiness checks; readiness must never hang. */
  READINESS_TIMEOUT_MS: z.coerce.number().int().min(50).max(10_000).default(1000),
});

export type ApiConfig = z.infer<typeof apiEnvSchema>;

export function loadConfig(source: Record<string, string | undefined> = process.env): ApiConfig {
  return parseEnv(apiEnvSchema, source);
}
