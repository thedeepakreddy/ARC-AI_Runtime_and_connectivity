import { describe, expect, it } from 'vitest';
import { cookieSecure, loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  const valid = {
    DATABASE_URL: 'postgres://arc@localhost:5432/arc',
    REDIS_URL: 'redis://localhost:6379',
    LITELLM_BASE_URL: 'http://localhost:4000',
    ARC_VAULT_KEY_FILE: '/run/secrets/arc/vault-keys.json',
    LITELLM_MASTER_KEY: 'sk-test-master',
  };

  it('loads with defaults', () => {
    const c = loadConfig(valid);
    expect(c.PORT).toBe(8080);
    expect(c.READINESS_TIMEOUT_MS).toBe(1000);
  });

  it('rejects missing required settings', () => {
    expect(() => loadConfig({ ...valid, REDIS_URL: undefined })).toThrow(/REDIS_URL/);
  });
});

describe('cookieSecure', () => {
  const valid = {
    DATABASE_URL: 'postgres://arc@localhost:5432/arc',
    REDIS_URL: 'redis://localhost:6379',
    LITELLM_BASE_URL: 'http://localhost:4000',
    ARC_VAULT_KEY_FILE: '/k.json',
    LITELLM_MASTER_KEY: 'sk-test-master',
  };
  it('defaults to secure cookies in production only', () => {
    expect(cookieSecure(loadConfig({ ...valid, NODE_ENV: 'production' }))).toBe(true);
    expect(cookieSecure(loadConfig({ ...valid, NODE_ENV: 'development' }))).toBe(false);
    expect(
      cookieSecure(loadConfig({ ...valid, NODE_ENV: 'development', COOKIE_SECURE: 'true' })),
    ).toBe(true);
  });
});
