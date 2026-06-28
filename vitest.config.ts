import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for ParamGuard.
 *
 * The E2E suite launches a real Chromium via Playwright, so the global timeout
 * is generous. Tests run in the Node environment and are isolated per file.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
});
