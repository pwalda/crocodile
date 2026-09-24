import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
