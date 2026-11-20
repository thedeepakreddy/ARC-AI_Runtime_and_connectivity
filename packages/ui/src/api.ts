/** The ARC admin API, same origin (console and dashboard). The session cookie (HttpOnly, SameSite=Strict) rides along. */

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

type Listener = () => void;
const unauthorized = new Set<Listener>();
/** Called when the session has ended (401), so the app can show the sign-in screen. */
export const onUnauthorized = (fn: Listener) => {
  unauthorized.add(fn);
  return () => {
    unauthorized.delete(fn);
  };
};

/**
 * The tenant requests act on (sent as x-arc-tenant). Needed only when the signed-in user belongs
 * to more than one tenant; the API refuses to guess.
 */
let tenantId: string | null = null;
export const setTenant = (id: string | null) => {
  tenantId = id;
};

const PUBLIC_PATHS = ['/auth/login', '/auth/signup', '/auth/invitations/'];

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (tenantId) headers['x-arc-tenant'] = tenantId;
  const res = await fetch(`/admin/v1${path}`, {
    method,
    credentials: 'same-origin',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !PUBLIC_PATHS.some((p) => path.startsWith(p)))
      unauthorized.forEach((fn) => fn());
    const e = data?.error ?? {};
    throw new ApiError(
      res.status,
      e.code ?? 'error',
      e.message ?? `Request failed (${res.status})`,
      e.details,
    );
  }
  return data as T;
}

export const get = <T>(path: string) => api<T>('GET', path);

// ---- Shapes returned by the admin API ----

export interface Me {
  user: { id: string; email: string; isSuperadmin: boolean };
  tenants: { id: string; kind: string; name: string; role: string }[];
}
export interface Provider {
  id: string;
  displayName: string;
  group: string;
  jurisdiction: string;
  adapter: string;
  defaultBaseUrl: string | null;
}
export type Health =
  'unknown' | 'healthy' | 'rate_limited' | 'invalid_credentials' | 'unreachable' | 'unsupported';
export interface ProviderAccount {
  id: string;
  providerId: string;
  label: string;
  scope: string;
  baseUrl: string | null;
  enabled: boolean;
  healthStatus: Health;
  lastValidatedAt: string | null;
  lastValidationError: string | null;
  secretHint: string | null;
  createdAt: string;
}
export type Eligibility = 'VERIFIED_FREE' | 'RESTRICTED_FREE' | 'PAID' | 'UNKNOWN';
export interface Model {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string | null;
  capabilities: string[];
  eligibility: Eligibility;
  eligibilityEvidenceUrl: string | null;
  eligibilityCheckedAt: string | null;
  termsNote: string | null;
  enabled: boolean;
  source: string;
}
export interface Application {
  id: string;
  name: string;
  slug: string;
  firstParty: boolean;
  createdAt: string;
}
export interface ApiKey {
  id: string;
  applicationId: string;
  name: string;
  displayPrefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  key?: string;
}
export interface Policy {
  applicationId: string | null;
  allowedJurisdictions: string[] | null;
  allowPaidOwnerKeys: boolean;
}
export interface NeedsYou {
  kind: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail?: string;
  href: string;
}
export interface Overview {
  range: string;
  services: { name: string; status: 'up' | 'down' }[];
  allUp: boolean;
  needsYou: NeedsYou[];
  counts: { modelsToClassify: number; failingKeys: number; alerts: number };
  totals: {
    requests: number;
    errorRate: number;
    fallbackRate: number;
    overheadMsAvg: number | null;
  };
  series: { t: string; requests: number; errors: number }[];
  byApp: { id: string; name: string; requests: number; errorRate: number }[];
  byProvider: { provider: string; requests: number; share: number }[];
}
export interface TrafficRow {
  id: string;
  label: string;
  requests: number;
  errorRate: number;
  fallbackRate: number;
  overheadMsAvg: number | null;
  durationMsAvg: number | null;
}
export interface Traffic {
  rows: TrafficRow[];
  series: {
    t: string;
    requests: number;
    errors: number;
    fallbacks: number;
    overheadMsAvg: number | null;
  }[];
}
export interface Customer {
  id: string;
  name: string;
  kind: string;
  createdAt: string;
  suspendedAt: string | null;
  members: number;
  apps: number;
  providerKeys: number;
  requests30d: number;
}
export interface AuditEvent {
  id: string;
  actorUserId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}
export interface Session {
  id: string;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
  current: boolean;
}
export interface Verdict {
  model: string;
  accountId: string;
  eligibility: Eligibility;
  jurisdiction: string;
  health: Health;
  expectedMs: number;
  verdict: string;
  detail?: string;
}
export interface Explain {
  routable: boolean;
  reason?: string;
  selected?: Verdict;
  fallbackOrder?: { model: string; accountId: string }[];
  candidates: Verdict[];
}

// ---- Customers (dashboard) ----

export interface Tenant {
  id: string;
  kind: string;
  name: string;
  role: 'owner' | 'admin' | 'member';
  createdAt: string;
}
export interface Member {
  userId: string;
  email: string;
  role: 'owner' | 'admin' | 'member';
  joinedAt: string;
  lastLoginAt: string | null;
  you: boolean;
}
export interface Invitation {
  id: string;
  email: string;
  role: 'owner' | 'admin' | 'member';
  createdAt: string;
  expiresAt: string;
  invitedBy: string | null;
  /** Only in the response that creates it. */
  token?: string;
}
export interface InvitationPreview {
  email: string;
  role: 'owner' | 'admin' | 'member';
  organization: string | null;
  newOrganization: boolean;
  expiresAt: string;
}
