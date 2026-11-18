import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  const valid = {
    DATABASE_URL: 'postgres://arc@localhost:5432/arc',
    REDIS_URL: 'redis://localhost:6379',
    LITELLM_BASE_URL: 'http://localhost:4000',
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
