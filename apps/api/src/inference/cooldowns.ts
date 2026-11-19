/**
 * Short-lived, per-instance memory of keys a provider just pushed back on. Respecting a
 * provider's rate limit means *not* sending that key more traffic until it recovers; other
 * legitimately registered keys may still serve. This is not used to defeat provider limits.
 */
export type CooldownReason = 'rate_limited' | 'auth_failed' | 'failing';

const RATE_LIMIT_DEFAULT_S = 30;
const RATE_LIMIT_MAX_S = 300;
const AUTH_FAILED_S = 600;
const FAILURE_THRESHOLD = 3;
const FAILING_S = 30;

export class Cooldowns {
  private readonly until = new Map<string, { at: number; reason: CooldownReason }>();
  private readonly consecutiveFailures = new Map<string, number>();
  /** Called when this instance starts a cooldown (e.g. to broadcast it to other instances). */
  onCooldown: ((accountId: string, reason: CooldownReason, seconds: number) => void) | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** Apply a cooldown learned from another instance (does not re-broadcast). */
  apply(accountId: string, reason: CooldownReason, seconds: number): void {
    this.set(accountId, Math.min(Math.max(seconds, 1), AUTH_FAILED_S), reason, false);
  }

  get(accountId: string): CooldownReason | null {
    const entry = this.until.get(accountId);
    if (!entry) return null;
    if (entry.at <= this.now()) {
      this.until.delete(accountId);
      return null;
    }
    return entry.reason;
  }

  rateLimited(accountId: string, retryAfterSeconds?: number): void {
    const s =
      retryAfterSeconds && retryAfterSeconds > 0
        ? Math.min(retryAfterSeconds, RATE_LIMIT_MAX_S)
        : RATE_LIMIT_DEFAULT_S;
    this.set(accountId, s, 'rate_limited');
  }

  authFailed(accountId: string): void {
    this.set(accountId, AUTH_FAILED_S, 'auth_failed');
  }

  /** Transient failure (5xx, timeout, network). Cools down after several in a row. */
  failed(accountId: string): void {
    const n = (this.consecutiveFailures.get(accountId) ?? 0) + 1;
    this.consecutiveFailures.set(accountId, n);
    if (n >= FAILURE_THRESHOLD) {
      this.set(accountId, FAILING_S, 'failing');
      this.consecutiveFailures.delete(accountId);
    }
  }

  succeeded(accountId: string): void {
    this.consecutiveFailures.delete(accountId);
  }

  clear(): void {
    this.until.clear();
    this.consecutiveFailures.clear();
  }

  private set(accountId: string, seconds: number, reason: CooldownReason, broadcast = true): void {
    this.until.set(accountId, { at: this.now() + seconds * 1000, reason });
    if (broadcast) this.onCooldown?.(accountId, reason, seconds);
    if (this.until.size > 50_000) {
      const oldest = this.until.keys().next();
      if (!oldest.done) this.until.delete(oldest.value);
    }
  }
}

/** Parse a Retry-After header (seconds or HTTP date). */
export function parseRetryAfter(
  value: string | null,
  now: number = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - now) / 1000));
}
