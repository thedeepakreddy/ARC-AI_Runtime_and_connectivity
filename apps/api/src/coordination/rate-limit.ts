import type { Redis } from 'ioredis';
import { AttemptLimiter } from '../auth/throttle.js';

export interface RateLimiter {
  /** Count one request for `key`; false when the key is over its per-minute limit. */
  hit(key: string): Promise<boolean>;
}

export class LocalRateLimiter implements RateLimiter {
  private readonly limiter: AttemptLimiter;
  constructor(perMinute: number) {
    this.limiter = new AttemptLimiter(perMinute, 60_000);
  }
  async hit(key: string): Promise<boolean> {
    return this.limiter.hit(key);
  }
}

/**
 * Per-key limit shared by all API instances: one atomic INCR (+EXPIRE) per request in a fixed
 * one-minute window. Bounded by a short command timeout; if Redis is slow or down, falls back
 * to this instance's local limiter rather than failing or slowing requests.
 */
export class RedisRateLimiter implements RateLimiter {
  private readonly local: LocalRateLimiter;
  degraded = 0;

  constructor(
    private readonly redis: Redis,
    private readonly perMinute: number,
    private readonly timeoutMs = 50,
  ) {
    this.local = new LocalRateLimiter(perMinute);
  }

  async hit(key: string): Promise<boolean> {
    const window = Math.floor(Date.now() / 60_000);
    const redisKey = `arc:rl:${key}:${window}`;
    try {
      const result = await Promise.race([
        this.redis.multi().incr(redisKey).expire(redisKey, 70).exec(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), this.timeoutMs).unref(),
        ),
      ]);
      const count = Number(result?.[0]?.[1]);
      if (!Number.isFinite(count)) throw new Error('bad reply');
      return count <= this.perMinute;
    } catch {
      this.degraded++;
      return this.local.hit(key);
    }
  }
}
