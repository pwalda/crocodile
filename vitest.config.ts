import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      // Logic under test; the desktop UI and Electron shell are covered by the
      // Electron smoke test instead (tests/electron/smoke.ts).
      include: ['packages/*/src/**/*.ts', 'apps/directory/src/**/*.ts'],
      exclude: ['**/bin.ts', '**/index.ts'],
      reporter: ['text-summary', 'html', 'json-summary'],
      reportsDirectory: 'coverage',
      // A ratchet, a little below today's numbers: raise as coverage grows.
      thresholds: { statements: 68, branches: 58, functions: 64, lines: 72 },
    },
  },
});
