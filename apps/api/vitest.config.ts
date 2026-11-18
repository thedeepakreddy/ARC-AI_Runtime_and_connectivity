import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['arc-source'] },
  ssr: { resolve: { conditions: ['arc-source'] } },
  test: { include: ['test/**/*.test.ts'] },
});
