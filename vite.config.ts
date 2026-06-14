/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';

// The React frontend lives in web/ (Vite `root`). It builds to repo-root dist/, which the
// Bun/Hono server serves in production (single origin). In dev, Vite serves web/ and proxies
// /api to the Bun server on :3000. The service worker is built via Workbox injectManifest so
// hashed bundles are precached, while web/src/service-worker.js keeps Relay's custom push /
// notificationclick / offline-navigation logic. It's emitted at dist/service-worker.js — the
// SAME url existing clients are registered against, so they upgrade in place.
export default defineConfig({
  root: 'web',
  plugins: [
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'service-worker.js',
      registerType: 'autoUpdate',
      injectRegister: null, // we register the SW ourselves (push flow needs serviceWorker.ready)
      manifest: false, // keep the existing static web/public/manifest.webmanifest
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico,webmanifest}'],
      },
      devOptions: { enabled: true, type: 'module' },
    }),
  ],
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    // Single proxy: forward the whole API (incl. the /api/stream SSE feed) to the Bun server.
    // The manifest + service worker are served by Vite/the PWA plugin in dev, so they are NOT
    // proxied. Production is single-origin (Bun serves the build), so no proxy there.
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: false, ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test-setup.ts'],
  },
});
