// Service worker for Relay — PWA offline shell + Web Push.
//
// Caching strategy (plain static app, NOT Next.js — there is no /_next/ bundle):
//   - /api/*          -> never intercepted; always live network (state must be fresh; SSE too).
//   - navigations/HTML -> network-FIRST, fall back to /offline.html when offline.
//   - app assets / icons / manifest -> cache-first (cheap, rarely change).
//
// BUMP CACHE_VERSION on EVERY change to a precached asset (app.js / app.css / vendor files),
// not just the first time one is added — otherwise clients keep stale JS until the old
// worker dies. Mermaid is deliberately NOT precached (large, lazy-loaded by app.js on demand).
const CACHE_VERSION = 'relay-v3';
const PRECACHE = [
  '/',
  '/offline.html',
  '/manifest.webmanifest',
  '/app.css',
  '/app.js',
  '/push-client.js',
  '/vendor/marked.min.js',
  '/vendor/purify.min.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  // Per-asset, best-effort precache: one missing/404 asset must NOT reject the whole
  // install (cache.addAll is atomic and would brick activation). allSettled is resilient.
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => Promise.allSettled(PRECACHE.map((url) => cache.add(url)))),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name !== CACHE_VERSION).map((name) => caches.delete(name))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (url.pathname.startsWith('/api/')) return; // always network, never cached (incl. SSE)
  if (request.method !== 'GET') return;

  const accept = request.headers.get('accept') || '';
  const isNavigation = request.mode === 'navigate' || accept.includes('text/html');

  if (isNavigation) {
    // Network-first; offline -> cached shell -> /offline.html.
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(CACHE_VERSION);
        return (await cache.match('/')) || (await cache.match('/offline.html')) || Response.error();
      }),
    );
    return;
  }

  // Cache-first for static assets we control (app js/css, icons, manifest, vendor libs).
  event.respondWith(
    caches.open(CACHE_VERSION).then(async (cache) => {
      const hit = await cache.match(request);
      if (hit) return hit;
      const resp = await fetch(request);
      const p = url.pathname;
      const cacheable =
        p.startsWith('/icons/') ||
        p.startsWith('/vendor/') ||
        p === '/manifest.webmanifest' ||
        p === '/app.css' ||
        p === '/app.js' ||
        p === '/push-client.js';
      if (resp.ok && cacheable) cache.put(request, resp.clone());
      return resp;
    }),
  );
});

// --- Web Push -------------------------------------------------------------
// Payload JSON sent by the server: { title, body, url, tag }.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Relay';
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag || 'relay',
    renotify: true,
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Focus an existing app window (navigating it to the target) or open a new one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          if ('navigate' in client) client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
