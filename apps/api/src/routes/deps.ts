import type { Db } from '../db/pool.js';
import type { CandidateStore } from '../inference/candidates.js';
import type { Cooldowns } from '../inference/cooldowns.js';
import type { ProviderProbe } from '../providers/probe.js';
import type { ReadinessReport } from '../readiness.js';
import type { CredentialService } from '../vault/credentials.js';

export interface AdminDeps {
  db: Db;
  credentials: CredentialService;
  probe: ProviderProbe;
  cookieSecure: boolean;
  sessionTtlMs: number;
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
