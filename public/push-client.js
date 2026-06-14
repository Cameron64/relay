// Framework-agnostic Web Push client for Relay.
//
// Drop this in and give a button id="notify-toggle" plus an element id="notify-status".
// It registers the service worker, then wires the toggle to subscribe/unsubscribe.
// No framework required — works in any page. (Adapt freely for React/Vue: the four
// functions below — register, subscribe, unsubscribe, isSubscribed — are the whole API.)

(function () {
  const toggle = document.getElementById('notify-toggle');
  const statusEl = document.getElementById('notify-status');

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  // VAPID public keys are base64url; PushManager wants a Uint8Array.
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const output = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
    return output;
  }

  // Register the SW as early as possible so `serviceWorker.ready` resolves fast later.
  async function register() {
    if (!('serviceWorker' in navigator)) return null;
    try {
      return await navigator.serviceWorker.register('/service-worker.js');
    } catch (err) {
      console.error('[push] SW registration failed', err);
      return null;
    }
  }

  function pushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  // iOS only allows Web Push when the PWA is installed to the home screen (standalone).
  function iosNeedsInstall() {
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    return isIos && !standalone;
  }

  async function isSubscribed() {
    if (!pushSupported()) return false;
    const reg = await navigator.serviceWorker.ready;
    return !!(await reg.pushManager.getSubscription());
  }

  async function subscribe() {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error(permission);

    const reg = await navigator.serviceWorker.ready;
    const res = await fetch('/api/push/public-key');
    if (!res.ok) throw new Error('push not configured on server');
    const { key } = await res.json();

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });

    const json = sub.toJSON();
    const save = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
        userLabel: navigator.userAgent.slice(0, 100),
      }),
    });
    if (!save.ok) throw new Error('failed to save subscription');
  }

  async function unsubscribe() {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => {});
      await sub.unsubscribe();
    }
  }

  async function refresh() {
    if (!toggle) return;
    if (!pushSupported()) {
      toggle.disabled = true;
      setStatus(iosNeedsInstall() ? 'Add to Home Screen to enable alerts' : 'Notifications not supported');
      return;
    }
    if (Notification.permission === 'denied') {
      toggle.disabled = true;
      setStatus('Notifications blocked in browser settings');
      return;
    }
    const on = await isSubscribed();
    toggle.disabled = false;
    toggle.textContent = on ? 'Disable notifications' : 'Enable notifications';
    setStatus(on ? 'Notifications on' : 'Notifications off');
  }

  async function init() {
    await register();
    await refresh();
    if (!toggle) return;
    toggle.addEventListener('click', async () => {
      toggle.disabled = true;
      setStatus('Working…');
      try {
        (await isSubscribed()) ? await unsubscribe() : await subscribe();
      } catch (err) {
        console.error('[push] toggle failed', err);
        setStatus(err && err.message === 'denied' ? 'Permission denied' : 'Something went wrong');
      }
      await refresh();
    });
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
