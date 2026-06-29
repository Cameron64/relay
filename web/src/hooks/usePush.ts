import { useCallback, useEffect, useState } from 'react';

// Web Push client, ported from the old public/push-client.js. The four primitives (register,
// subscribe, unsubscribe, isSubscribed) are the whole API. SW registration itself happens once in
// main.tsx; this hook drives the subscription toggle and surfaces support/permission/iOS state.

function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

// iOS only allows Web Push when the PWA is installed to the home screen (standalone).
function iosNeedsInstall(): boolean {
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  return isIos && !standalone;
}

// VAPID public keys are base64url; PushManager wants a Uint8Array. Back it with an explicit
// ArrayBuffer so the type is Uint8Array<ArrayBuffer> (assignable to BufferSource under TS 5.7+).
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const output = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

async function isSubscribed(): Promise<boolean> {
  if (!pushSupported()) return false;
  const reg = await navigator.serviceWorker.ready;
  return !!(await reg.pushManager.getSubscription());
}

// Per-device opt-in flag. Set when the user taps Enable, cleared when they tap Disable. reconcile()
// uses it to tell "the browser silently dropped my subscription" (heal it) apart from "I turned push
// off on purpose" (leave it off) — both look identical otherwise: permission granted, no subscription.
const INTENT_KEY = 'relay:push-intent';
function wantsPush(): boolean {
  try {
    return localStorage.getItem(INTENT_KEY) === 'on';
  } catch {
    return false;
  }
}
function setWantsPush(on: boolean): void {
  try {
    localStorage.setItem(INTENT_KEY, on ? 'on' : 'off');
  } catch {
    /* storage disabled (private mode) — intent just won't persist across reloads */
  }
}

// Register a browser subscription with the server (idempotent upsert keyed on endpoint).
async function saveSubscription(sub: PushSubscription): Promise<boolean> {
  const json = sub.toJSON();
  const save = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
      userLabel: navigator.userAgent.slice(0, 100),
    }),
  });
  return save.ok;
}

// Create a fresh browser subscription and register it server-side. Assumes notification permission
// is ALREADY granted (callers check) so reg.pushManager.subscribe() resolves without a prompt —
// which is what lets reconcile() heal a dropped subscription silently. Shared by the user-initiated
// subscribe() and the silent self-heal below.
async function createSubscription(): Promise<void> {
  const reg = await navigator.serviceWorker.ready;
  const res = await fetch('/api/push/public-key');
  if (!res.ok) throw new Error('push not configured on server');
  const { key } = await res.json();
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key),
  });
  if (!(await saveSubscription(sub))) throw new Error('failed to save subscription');
}

// Keep the server in sync on every app open AND self-heal a silently-dropped subscription. With
// permission granted there are three cases:
//   • subscription present       → re-assert it server-side (heals a pruned/lost server row), and
//                                   backfill the intent flag so a later drop self-heals even for
//                                   devices that subscribed before this flag existed.
//   • gone, but user wants push  → the browser dropped it (FCM rotation, SW/storage eviction) while
//                                   permission stayed granted — re-create it with NO prompt. This is
//                                   the "notifications stay on" fix.
//   • gone, user turned it off   → leave it off; don't fight a deliberate disable.
// Returns true only when it re-created a subscription, so the caller can refresh the toggle. All
// failures are swallowed — best-effort, must never throw into render.
async function reconcile(): Promise<boolean> {
  try {
    if (!pushSupported() || Notification.permission !== 'granted') return false;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      setWantsPush(true);
      await saveSubscription(sub);
      return false;
    }
    if (wantsPush()) {
      await createSubscription();
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function subscribe(): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(permission);
  await createSubscription();
  setWantsPush(true);
}

async function unsubscribe(): Promise<void> {
  setWantsPush(false);
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

export interface PushState {
  supported: boolean;
  enabled: boolean;
  busy: boolean;
  status: string;
  disabled: boolean;
  toggle: () => Promise<void>;
}

export function usePush(): PushState {
  const [supported, setSupported] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [disabled, setDisabled] = useState(true);

  const refresh = useCallback(async () => {
    if (!pushSupported()) {
      setSupported(false);
      setDisabled(true);
      setStatus(iosNeedsInstall() ? 'Add to Home Screen to enable alerts' : 'Notifications not supported');
      return;
    }
    if (Notification.permission === 'denied') {
      setDisabled(true);
      setStatus('Notifications blocked in browser settings');
      return;
    }
    const on = await isSubscribed();
    setEnabled(on);
    setDisabled(false);
    setStatus(on ? 'Notifications on' : 'Notifications off');
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await refresh();
      // Re-assert (or silently re-create) the subscription server-side. If it re-created one, the
      // earlier refresh() saw "off" — refresh again so the toggle reflects the healed state.
      const healed = await reconcile();
      if (healed && !cancelled) await refresh();
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const toggle = useCallback(async () => {
    setBusy(true);
    setStatus('Working…');
    try {
      (await isSubscribed()) ? await unsubscribe() : await subscribe();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      setStatus(msg === 'denied' ? 'Permission denied' : 'Something went wrong');
    }
    setBusy(false);
    await refresh();
  }, [refresh]);

  return { supported, enabled, busy, status, disabled, toggle };
}
