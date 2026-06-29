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
// VAPID public keys are base64url; PushManager.subscribe wants a Uint8Array. Mirrors the helper in
// web/src/hooks/usePush.ts — deliberately duplicated rather than shared, because the service worker
// is built as a separate bundle and an inlined 8-line decoder is lower-risk than a cross-bundle
// import for the very code path that keeps push alive.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

// The browser can rotate or invalidate a push subscription on its own (key rotation, storage
// eviction) — when it does, the old server row is dead and the device goes silent with no UI cue.
// Re-subscribe with the current VAPID key and re-register the new endpoint so delivery self-heals.
// Best-effort: the client-side reconcile (usePush.ts) on next app open is the backstop.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const res = await fetch('/api/push/public-key');
        if (!res.ok) return;
        const { key } = await res.json();
        const sub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(key),
        });
        const json = sub.toJSON();
        await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            endpoint: json.endpoint,
            keys: { p256dh: json.keys && json.keys.p256dh, auth: json.keys && json.keys.auth },
            userLabel: (navigator.userAgent || '').slice(0, 100),
          }),
        });
      } catch {
        /* best-effort — client reconcile on next app open recovers it */
      }
    })(),
  );
});

// Payload JSON sent by the server: { title, body, url, tag, cardId?, actions?, requireInteraction? }.
// `actions` (max 2 on Chrome/Android) render as tappable buttons; a tap on one is handled in
// notificationclick below — it POSTs the button id to /respond WITHOUT opening the app. The one
// reserved action, '__reply' (prompt cards), is the exception: it OPENS the app focused on the
// reply box, because free text can't be typed from a notification.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Relay';
  const actions = Array.isArray(data.actions) ? data.actions.slice(0, 2) : [];
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.tag || 'relay',
      renotify: true,
      requireInteraction: !!data.requireInteraction,
      data: { url: data.url || '/', cardId: data.cardId || null },
      ...(actions.length ? { actions } : {}),
      ...(data.requireInteraction ? { vibrate: [200, 100, 200] } : {}),
    }),
  );
});

// Focus an existing app window (navigating it to the target) or open a new one.
function openOrFocus(target) {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    for (const client of clients) {
      if ('focus' in client) {
        if ('navigate' in client) client.navigate(target);
        return client.focus();
      }
    }
    return self.clients.openWindow(target);
  });
}

// Tap on an action button: POST the verdict to /respond in the background (same-origin fetch sends
// the httpOnly relay_session cookie). On success — or if it was already answered — quietly update
// the notification in place. If the device isn't unlocked (401) or the request fails, fall back to
// opening the app at the card so the user can respond there.
async function respondInBackground(cardId, action, url) {
  try {
    const res = await fetch(`/api/cards/${cardId}/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ action }),
    });
    if (res.ok || res.status === 409) {
      await self.registration.showNotification('Relay', {
        body: 'Response sent ✓',
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: cardId,
        silent: true,
      });
      return;
    }
  } catch {
    /* fall through to opening the app */
  }
  return openOrFocus(url);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  const target = d.url || '/';
  // '__reply' (prompt cards) must OPEN the app focused on the reply box — you can't type free text
  // from a notification. The target url already carries &reply=1, so opening it lands on the composer.
  if (event.action === '__reply') {
    event.waitUntil(openOrFocus(target));
    return;
  }
  if (event.action && d.cardId) {
    event.waitUntil(respondInBackground(d.cardId, event.action, target));
    return;
  }
  event.waitUntil(openOrFocus(target));
});
