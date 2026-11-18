import type { Db } from '../db/pool.js';
import type { ProviderProbe } from '../providers/probe.js';
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
}

export const isUniqueViolation = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
