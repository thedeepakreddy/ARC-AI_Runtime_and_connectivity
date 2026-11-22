import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The public website, served by the ARC API at / with every file under /site-assets/ (so it
// never shadows /v1, /admin, /console or /dashboard). Try now leads to /dashboard.
export default defineConfig({
  base: '/',
  plugins: [react()],
  build: { outDir: 'dist', assetsDir: 'site-assets', sourcemap: false, chunkSizeWarningLimit: 900 },
  server: {
    proxy: {
      '/dashboard': process.env.ARC_URL ?? 'http://127.0.0.1:8080',
      '/admin': process.env.ARC_URL ?? 'http://127.0.0.1:8080',
    },
  },
});
