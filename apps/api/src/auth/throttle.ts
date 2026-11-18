/**
 * In-memory sliding-window limiter for login attempts. Sufficient for the single-instance
 * pilot; move to Redis before running multiple API instances.
 */
export class AttemptLimiter {
  private readonly attempts = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Record an attempt; returns false if the key is over its limit. */
  hit(key: string): boolean {
    const cutoff = this.now() - this.windowMs;
    const recent = (this.attempts.get(key) ?? []).filter((t) => t > cutoff);
    recent.push(this.now());
    this.attempts.set(key, recent);
    if (this.attempts.size > 10_000) this.prune(cutoff);
    return recent.length <= this.max;
  }

  reset(key: string): void {
    this.attempts.delete(key);
  }

  private prune(cutoff: number): void {
    for (const [key, times] of this.attempts) {
      if (times.every((t) => t <= cutoff)) this.attempts.delete(key);
    }
  }
}
