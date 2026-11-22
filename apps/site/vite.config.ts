import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The public website, served by the ARC API at / with every file under /site-assets/ (so it
// never shadows /v1, /admin, /console or /dashboard). Try now leads to /dashboard.
export default defineConfig({
  base: '/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    assetsDir: 'site-assets',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    // Every browser with WebGL 2 (which the sky needs): Safari/iOS 15+, Chrome, Edge, Firefox,
    // Samsung Internet. Newer syntax is compiled down for them.
    target: ['es2020', 'safari15', 'ios15', 'chrome90', 'edge90', 'firefox90'],
  },
  server: {
    proxy: {
      '/dashboard': process.env.ARC_URL ?? 'http://127.0.0.1:8080',
      '/admin': process.env.ARC_URL ?? 'http://127.0.0.1:8080',
    },
  },
});
