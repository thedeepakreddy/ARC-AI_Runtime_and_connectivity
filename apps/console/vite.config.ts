import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Served by the ARC API at /console (same origin as /admin/v1). In development, Vite proxies the
// admin API to a local ARC.
export default defineConfig({
  base: '/console/',
  plugins: [react()],
  build: { outDir: 'dist', assetsDir: 'assets', sourcemap: false },
  server: { proxy: { '/admin': process.env.ARC_URL ?? 'http://127.0.0.1:8080' } },
});
