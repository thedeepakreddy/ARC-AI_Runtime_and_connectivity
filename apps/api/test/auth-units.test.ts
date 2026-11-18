import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { AttemptLimiter } from '../src/auth/throttle.js';

describe('password hashing', () => {
  it('verifies the right password and rejects others', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(hash).not.toContain('correct');
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong horse battery', hash)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
});

describe('AttemptLimiter', () => {
  it('blocks after the limit and recovers after the window', () => {
    let now = 0;
    const limiter = new AttemptLimiter(2, 1000, () => now);
    expect(limiter.hit('k')).toBe(true);
    expect(limiter.hit('k')).toBe(true);
    expect(limiter.hit('k')).toBe(false);
    now = 2000;
    expect(limiter.hit('k')).toBe(true);
  });
});
