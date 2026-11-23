import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';
import {VitePWA} from 'vite-plugin-pwa';

export default defineConfig(({command}) => {
  const isBuild = command === 'build';
  return {
    base: isBuild ? process.env.VITE_BASE_PATH || './' : '/',
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'pwa-dev-sw-mime-guard',
        apply: 'serve',
        configureServer(server) {
          const minimalDevSw = [
            "self.addEventListener('install', () => { self.skipWaiting(); });",
            "self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });",
            "self.addEventListener('notificationclick', (event) => { event.notification.close(); var scopeUrl = (self.registration && self.registration.scope) || '/'; var resolvedUrl = new URL('./?tab=bills', scopeUrl).href; event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => { for (const c of clients) { if ('focus' in c) { c.focus(); c.postMessage && c.postMessage({ type: 'TALA_OPEN_BILLS' }); return c; } } if (self.clients.openWindow) return self.clients.openWindow(resolvedUrl); })); });",
          ].join('\n');

          server.middlewares.use((req, res, next) => {
            const rawUrl = req.url || '';
            const urlPath = rawUrl.split('?')[0];

            if (
              process.env.DISABLE_HMR === 'true' &&
              urlPath === '/@vite-plugin-pwa/pwa-entry-point-loaded'
            ) {
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
              res.setHeader('Cache-Control', 'no-cache');
              res.end(
                [
                  'export default function registerDevSW() {',
                  "  if ('serviceWorker' in navigator) {",
                  "    navigator.serviceWorker.register('/dev-sw.js?dev-sw', { scope: '/', type: 'classic' }).catch(() => {});",
                  '  }',
                  '}',
                ].join('\n')
              );
              return;
            }

            if (urlPath === '/dev-sw.js' || urlPath === '/sw.js') {
              const devSwPath = path.resolve(__dirname, 'dev-dist/sw.js');
              if (process.env.DISABLE_HMR === 'true') {
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
                res.setHeader('Cache-Control', 'no-cache');
                res.end(minimalDevSw);
                return;
              }
              if (rawUrl === '/dev-sw.js') {
                req.url = '/dev-sw.js?dev-sw';
              }
              if (urlPath === '/sw.js' && fs.existsSync(devSwPath)) {
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
                res.setHeader('Cache-Control', 'no-cache');
                res.end(fs.readFileSync(devSwPath, 'utf8'));
                return;
              }
            }

            if (/^\/workbox-[a-zA-Z0-9_-]+\.js$/.test(urlPath)) {
              const wbPath = path.resolve(__dirname, 'dev-dist', urlPath.slice(1));
              if (fs.existsSync(wbPath)) {
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
                res.setHeader('Cache-Control', 'no-cache');
                res.end(fs.readFileSync(wbPath, 'utf8'));
                return;
              }
            }

            next();
          });
        },
      },
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'icon.svg', 'sw-notifications.js'],
        manifest: {
          id: './',
          name: 'Tala Ledger — Budget Tracker',
          short_name: 'Tala Ledger',
          description:
            'Offline-ready Material Design 3 budget tracker with Salary Planner, Bills, Credit Cards, remittances, savings, and Google Cloud Sync.',
          theme_color: '#0b57d0',
          background_color: '#f8fafd',
          display: 'standalone',
          display_override: ['standalone', 'minimal-ui'],
          orientation: 'any',
          start_url: './',
          scope: './',
          categories: ['finance', 'productivity', 'utilities'],
          prefer_related_applications: false,
          shortcuts: [
            {
              name: 'Bills & Reminders',
              short_name: 'Bills',
              description: 'Open recurring bills and due notifications',
              url: './?tab=bills',
              icons: [{src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png'}],
            },
            {
              name: 'Salary Planner',
              short_name: 'Salary',
              description: 'Open active payout cycle and deductions',
              url: './?tab=salary',
              icons: [{src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png'}],
            },
          ],
          icons: [
            {
              src: 'pwa-192x192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: 'pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: 'pwa-maskable-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
          maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
          navigateFallback: 'index.html',
          importScripts: ['sw-notifications.js'],
        },
        devOptions: {
          enabled: true,
          type: 'classic',
        },
      }),
      // Copies src/assets into dist/ so root-relative URLs like
      // "/src/assets/images/..." (e.g. generate_image output) still resolve
      // in production builds. Do not remove.
      {
        name: 'copy-unbundled-src-assets',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const distDir = path.resolve(__dirname, 'dist');
          const srcAssets = path.resolve(__dirname, 'src/assets');
          const distAssets = path.resolve(distDir, 'src/assets');
          if (fs.existsSync(distDir) && fs.existsSync(srcAssets)) {
            fs.cpSync(srcAssets, distAssets, {recursive: true, force: true});
          }
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
