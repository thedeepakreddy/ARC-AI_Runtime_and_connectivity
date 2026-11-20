import type { Db } from '../db/pool.js';
import type { CandidateStore } from '../inference/candidates.js';
import type { Cooldowns } from '../inference/cooldowns.js';
import type { ProviderProbe } from '../providers/probe.js';
import type { ReadinessReport } from '../readiness.js';
import type { ThrottleFactory } from '../coordination/throttle.js';
import type { Mailer } from '../mail/mailer.js';
import type { CredentialService } from '../vault/credentials.js';

export interface AdminDeps {
  db: Db;
  credentials: CredentialService;
  probe: ProviderProbe;
  cookieSecure: boolean;
  sessionTtlMs: number;
  /** Attempt limits (sign-in, sign-up); shared through Redis when configured. Default: local. */
  throttle?: ThrottleFactory;
  /** Transactional email; password reset and email verification need it. */
  mailer?: Mailer | undefined;
  /** Public address (https://arc.example.com) for links in emails and Google sign-in. */
  publicUrl?: string | undefined;
  /** Google sign-in; off when absent. */
  google?: GoogleConfig | undefined;
  /** Customer sign-up: invitation only (default) or open. */
  signupMode?: 'invite' | 'open';
  probeTimeoutMs: number;
  /** Override the SSRF URL guard (tests only). */
  assertPublicUrl?: (url: string) => Promise<void>;
  /** Called after changes that affect routing (keys, models), to drop cached candidates. */
  onRoutingChange?: () => void;
  /** Called when an ARC API key is revoked, to drop it from the verifier cache. */
  onApiKeyRevoked?: (keyId: string) => void;
  /** Shared routing state, for the explain endpoint. */
  routing?: { candidates: CandidateStore; cooldowns: Cooldowns };
  /** Live dependency check, for the console overview. */
  readiness?: () => Promise<ReadinessReport>;
  /** Alertmanager base URL, for firing alerts in the console overview. */
  alertmanagerUrl?: string | undefined;
}

export const isUniqueViolation = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  /** Overridable for tests; Google's endpoints by default. */
  authUrl?: string;
  tokenUrl?: string;
  userinfoUrl?: string;
}
