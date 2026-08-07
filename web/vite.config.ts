import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * `npm run dev` starts Vite on port 5173 and forwards /api to a running
 * `devcontext web` (which serves the API and, in production, these assets).
 */
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.DEVCONTEXT_API ?? 'http://127.0.0.1:4173',
        changeOrigin: true,
      },
    },
  },
});
