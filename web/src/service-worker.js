/* eslint-disable no-restricted-globals */
// Relay service worker — built by vite-plugin-pwa (Workbox injectManifest). Workbox injects the
// precache manifest of hashed build assets into self.__WB_MANIFEST; the rest is hand-written so
// Relay keeps its exact push / notificationclick / network-first-navigation behavior.
//
// This is emitted to dist/service-worker.js — the SAME url existing clients are registered against
// (see vite.config.ts `filename`), so old hand-written-SW clients upgrade in place.
import { precacheAndRoute, cleanupOutdatedCaches, matchPrecache } from 'workbox-precaching';
import { clientsClaim } from 'workbox-core';

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
self.skipWaiting();
clientsClaim();

const OFFLINE_URL = '/offline.html';

// Navigation = network-FIRST (state must be fresh), falling back to the precached app shell, then
// the offline page. Static assets are served by precacheAndRoute; /api/* is never intercepted.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) return; // never cache API / SSE
  const accept = request.headers.get('accept') || '';
  const isNavigation = request.mode === 'navigate' || accept.includes('text/html');
  if (!isNavigation) return; // let precacheAndRoute handle static assets

  event.respondWith(
    fetch(request).catch(
      async () =>
        (await matchPrecache('/index.html')) || (await matchPrecache(OFFLINE_URL)) || Response.error(),
    ),
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
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.tag || 'relay',
      renotify: true,
      data: { url: data.url || '/' },
    }),
  );
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
