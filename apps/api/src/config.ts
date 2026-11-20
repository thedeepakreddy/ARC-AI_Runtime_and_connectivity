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
  /** Internal key ARC uses to call LiteLLM. Never given to applications. */
  LITELLM_MASTER_KEY: z.string().min(8),
  /** Request deadline: default and hard maximum. Apps may lower it with x-arc-deadline-ms. */
  DEFAULT_DEADLINE_MS: z.coerce.number().int().min(1000).max(3_600_000).default(300_000),
  MAX_DEADLINE_MS: z.coerce.number().int().min(1000).max(3_600_000).default(600_000),
  /** Max inference request body (images/audio are passed through transiently). */
  INFERENCE_BODY_LIMIT_MB: z.coerce.number().min(1).max(100).default(20),
  /** Per ARC API key, per API instance. */
  /** On shutdown, wait this long for in-flight streams before force-closing connections. */
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).max(120_000).default(15_000),
  /** Provider attempts per request (first try + fallbacks), bounded by the deadline. */
  MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(3),
  MIN_ATTEMPT_MS: z.coerce.number().int().min(50).max(60_000).default(250),
  /** Prometheus metrics on a separate, internal-only port (0 disables). */
  METRICS_HOST: z.string().default('0.0.0.0'),
  /** Alertmanager, for the console's "Needs you" list (e.g. http://alertmanager:9093). Optional. */
  ALERTMANAGER_URL: z.url().optional(),
  /** Built console (apps/console/dist), served at /console when set. */
  CONSOLE_DIR: z.string().optional(),
  /** Built customer dashboard (apps/dashboard/dist), served at /dashboard. */
  DASHBOARD_DIR: z.string().optional(),
  /**
   * Customer sign-up: 'invite' (default) needs an invitation link from the owner or a tenant
   * admin; 'open' lets anyone create an organization. Customers only ever use their own keys.
   */
  SIGNUP_MODE: z.enum(['invite', 'open']).default('invite'),
  /** Public address of this ARC (https://arc.example.com), for links in emails and Google sign-in. */
  PUBLIC_URL: z.preprocess((v) => (v === '' ? undefined : v), z.url().optional()),
  /** Transactional email (password reset, email verification). Off unless all are set. */
  MAIL_SMTP_HOST: z.string().optional(),
  MAIL_SMTP_USER: z.string().optional(),
  MAIL_SMTP_PASSWORD_FILE: z.string().default('/run/secrets/arc/smtp-password'),
  MAIL_FROM: z.string().optional(),
  MAIL_REQUIRE_TLS: bool.default(true),
  /** Google sign-in. Off unless GOOGLE_CLIENT_ID and PUBLIC_URL are set. */
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET_FILE: z.string().default('/run/secrets/arc/google-client-secret'),
  METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(9464),
  /** "redis" shares revocations, cooldowns and routing changes across API instances. */
  COORDINATION: z.enum(['redis', 'local']).default('redis'),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(600),
});

export type ApiConfig = z.infer<typeof apiEnvSchema>;

export function loadConfig(source: Record<string, string | undefined> = process.env): ApiConfig {
  return parseEnv(apiEnvSchema, source);
}

export function cookieSecure(config: ApiConfig): boolean {
  return config.COOKIE_SECURE ?? config.NODE_ENV === 'production';
}
