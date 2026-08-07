import { defineConfig } from 'vitest/config';

/**
 * End to end tests talk to the real GitHub API. They need a token in
 * $DEVCONTEXT_E2E_TOKEN or $GITHUB_TOKEN and skip themselves without one.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.e2e.test.ts'],
    environment: 'node',
    testTimeout: 300_000,
    hookTimeout: 60_000,
    // Without a token every test skips itself, which must not fail the run.
    passWithNoTests: true,
    // Real API calls: run one file at a time so the rate limit is not shared.
    fileParallelism: false,
  },
});
