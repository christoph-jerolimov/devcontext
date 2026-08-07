import { defineConfig } from 'vitest/config';

/**
 * The default run is offline and deterministic: end to end tests live in
 * `*.e2e.test.ts` and are run separately by `npm run test:e2e`.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'src/**/*.e2e.test.ts'],
    environment: 'node',
  },
});
