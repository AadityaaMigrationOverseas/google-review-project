import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'], externalConditions: ['source'] } },
  test: {
    include: ['shared/test/**/*.test.ts', 'server/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
});
