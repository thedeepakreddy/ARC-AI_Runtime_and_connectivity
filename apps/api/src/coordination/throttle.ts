import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { AttemptLimiter } from '../auth/throttle.js';

/** Attempt limits for sign-in, sign-up and invitation lookups. */
export interface Throttle {
  /** Count one attempt for `key`; false when it is over the limit. */
  hit(key: string): Promise<boolean>;
  /** Forget a key's attempts (after a successful sign-in). */
  reset(key: string): Promise<void>;
}

export type ThrottleFactory = (name: string, max: number, windowMs: number) => Throttle;

/** This instance only (the single-instance pilot, and tests). */
export const localThrottle: ThrottleFactory = (_name, max, windowMs) => {
  const limiter = new AttemptLimiter(max, windowMs);
  return {
    async hit(key) {
      return limiter.hit(key);
    },
    async reset(key) {
      limiter.reset(key);
    },
  };
};

/**
 * Shared by every API instance through Redis: a fixed window per key (INCR + PEXPIRE). Keys are
 * hashed, so emails and addresses never sit in Redis. If Redis is slow or down, falls back to
 * this instance's own limiter: limits stay on, just not shared, and sign-in never waits on Redis.
 */
export function redisThrottle(redis: Redis, timeoutMs = 50): ThrottleFactory {
  return (name, max, windowMs) => {
    const local = localThrottle(name, max, windowMs);
    const keyOf = (key: string) => {
      const window = Math.floor(Date.now() / windowMs);
      const h = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 32);
      return `arc:th:${name}:${h}:${window}`;
    };
    const bounded = <T>(p: Promise<T>) =>
      Promise.race([
        p,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), timeoutMs).unref(),
        ),
      ]);
    return {
      async hit(key) {
        const k = keyOf(key);
        try {
          const r = await bounded(
            redis
              .multi()
              .incr(k)
              .pexpire(k, windowMs + 1000)
              .exec(),
          );
          const count = Number(r?.[0]?.[1]);
          if (!Number.isFinite(count)) throw new Error('bad reply');
          return count <= max;
        } catch {
          return local.hit(key);
        }
      },
      async reset(key) {
        await bounded(redis.del(keyOf(key))).catch(() => undefined);
        await local.reset(key);
      },
    };
  };
}
