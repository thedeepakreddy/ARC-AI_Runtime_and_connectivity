import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { localThrottle, redisThrottle } from '../src/coordination/throttle.js';

const TEST_REDIS_URL = process.env.TEST_REDIS_URL;

describe('sign-in throttles', () => {
  it('local: limits per key and resets', async () => {
    const t = localThrottle('t', 2, 60_000);
    expect(await t.hit('a')).toBe(true);
    expect(await t.hit('a')).toBe(true);
    expect(await t.hit('a')).toBe(false);
    expect(await t.hit('b')).toBe(true);
    await t.reset('a');
    expect(await t.hit('a')).toBe(true);
  });

  it('falls back to the local limit when Redis is unreachable', async () => {
    const dead = new Redis('redis://127.0.0.1:1', {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
    });
    dead.on('error', () => undefined);
    const t = redisThrottle(dead, 20)('t', 1, 60_000);
    expect(await t.hit('x')).toBe(true);
    expect(await t.hit('x')).toBe(false);
    dead.disconnect();
  });
});

describe.skipIf(!TEST_REDIS_URL)('sign-in throttles shared through Redis', () => {
  const a = new Redis(TEST_REDIS_URL!);
  const b = new Redis(TEST_REDIS_URL!);
  afterAll(() => {
    a.disconnect();
    b.disconnect();
  });

  it('two API instances share one count, and keys are hashed', async () => {
    // Both connections ready first: a hit that times out falls back to the per-instance count
    // by design, which would make the shared count look wrong on a busy CI runner.
    await Promise.all([a.ping(), b.ping()]);
    const name = `test-${Date.now()}`;
    const one = redisThrottle(a, 5000)(name, 3, 60_000);
    const two = redisThrottle(b, 5000)(name, 3, 60_000);
    expect(await one.hit('person@example.test')).toBe(true);
    expect(await two.hit('person@example.test')).toBe(true);
    expect(await one.hit('person@example.test')).toBe(true);
    expect(await two.hit('person@example.test')).toBe(false);
    const keys = await a.keys(`arc:th:${name}:*`);
    expect(keys.length).toBe(1);
    expect(keys[0]).not.toContain('example.test');
    await one.reset('person@example.test');
    expect(await two.hit('person@example.test')).toBe(true);
  });
});
