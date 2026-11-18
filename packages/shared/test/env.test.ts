import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigError, baseEnvSchema, parseEnv } from '../src/index.js';

describe('parseEnv', () => {
  const schema = baseEnvSchema.extend({ DATABASE_URL: z.url() });

  it('applies defaults and returns typed config', () => {
    const env = parseEnv(schema, { DATABASE_URL: 'postgres://localhost/arc' });
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('names invalid variables without echoing their values', () => {
    const secret = 'super-secret-not-a-url';
    let error: unknown;
    try {
      parseEnv(schema, { DATABASE_URL: secret });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain('DATABASE_URL');
    expect((error as Error).message).not.toContain(secret);
  });
});
