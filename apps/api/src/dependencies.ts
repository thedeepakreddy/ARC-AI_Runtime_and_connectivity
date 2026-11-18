import { Redis } from 'ioredis';
import pg from 'pg';
import type { ApiConfig } from './config.js';
import type { DependencyCheck } from './readiness.js';

export interface Dependencies {
  checks: DependencyCheck[];
  close(): Promise<void>;
}

export function createDependencies(config: ApiConfig): Dependencies {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: config.READINESS_TIMEOUT_MS,
    idleTimeoutMillis: 30_000,
  });
  // Pool errors on idle clients must not crash the process.
  pool.on('error', () => undefined);

  const redis = new Redis(config.REDIS_URL, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: config.READINESS_TIMEOUT_MS,
  });
  redis.on('error', () => undefined);

  const litellmHealthUrl = new URL('/health/liveliness', config.LITELLM_BASE_URL);

  const checks: DependencyCheck[] = [
    {
      name: 'postgres',
      async check() {
        await pool.query('SELECT 1');
      },
    },
    {
      name: 'redis',
      async check() {
        if (redis.status === 'wait' || redis.status === 'end') await redis.connect();
        await redis.ping();
      },
    },
    {
      name: 'litellm',
      async check(signal) {
        const res = await fetch(litellmHealthUrl, { signal });
        if (!res.ok) throw new Error(`litellm responded ${res.status}`);
        await res.body?.cancel();
      },
    },
  ];

  return {
    checks,
    async close() {
      await Promise.allSettled([pool.end(), redis.quit()]);
    },
  };
}
