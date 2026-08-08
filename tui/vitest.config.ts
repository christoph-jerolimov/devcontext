import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  // dist holds a compiled copy of everything in src; without this vitest finds
  // the built tests as well and runs each of them twice.
  test: { environment: 'node', include: ['src/**/*.test.{ts,tsx}'] },
});
