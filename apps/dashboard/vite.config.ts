import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The customer dashboard, served by the ARC API at /dashboard (same origin as /admin/v1, so the
// SameSite=Strict session cookie works). In development, Vite proxies the admin API.
export default defineConfig({
  base: '/dashboard/',
  plugins: [react()],
  build: { outDir: 'dist', assetsDir: 'assets', sourcemap: false },
  server: { proxy: { '/admin': process.env.ARC_URL ?? 'http://127.0.0.1:8080' } },
});
