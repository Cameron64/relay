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

// Per-device push intent flag in localStorage. The ONLY value that suppresses self-heal is an explicit
// 'off' (the user tapped Disable). Anything else — 'on', or unset — counts as "wants push" once
// notification permission is granted. Defaulting *unset* to "wants push" is deliberate and load-bearing:
// a device can reach this code with its subscription already dropped and no flag yet (it dropped before
// the flag mechanism first ran, or localStorage was evicted). Requiring an explicit 'on' left those
// devices stuck off forever — the exact bug this fixes. Permission only becomes 'granted' via the
// user-initiated subscribe() below, so "granted + not explicitly off" is a safe proxy for real intent.
const INTENT_KEY = 'relay:push-intent';
function optedOut(): boolean {
  try {
    return localStorage.getItem(INTENT_KEY) === 'off';
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

// Keep the server in sync on every app open/resume AND self-heal a silently-dropped subscription.
// With permission granted there are three outcomes:
//   • subscription present        → re-assert it server-side (heals a pruned/lost server row) and
//                                    record intent='on'.
//   • gone, not explicitly off    → the browser dropped it (FCM rotation, SW/storage eviction) while
//                                    permission stayed granted — re-create it with NO prompt. This is
//                                    the "notifications stay on" fix. We heal on a *missing* flag too,
//                                    not just 'on', so a device that dropped before the flag ever
//                                    persisted still recovers.
//   • gone, user tapped Disable   → intent is 'off'; leave it off, don't fight a deliberate disable.
// Returns 'healed' when it re-created a subscription (caller refreshes the toggle), 'failed' when the
// silent re-create threw (caller surfaces it), or 'noop' otherwise. Never throws into render.
async function reconcile(): Promise<'healed' | 'failed' | 'noop'> {
  try {
    if (!pushSupported() || Notification.permission !== 'granted') return 'noop';
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      setWantsPush(true);
      await saveSubscription(sub);
      return 'noop';
    }
    if (optedOut()) return 'noop';
  } catch {
    return 'noop'; // couldn't read SW/permission/storage state — nothing actionable
  }
  // Permission granted, no live subscription, not explicitly disabled → re-create silently.
  try {
    await createSubscription();
    return 'healed';
  } catch {
    return 'failed';
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
    // One reconcile pass: sync the toggle from current state, then self-heal a dropped subscription.
    // Runs on mount AND every time the PWA returns to the foreground. An installed app usually
    // *resumes* (no React remount) when reopened, so a mount-only pass would miss most reopens — which
    // is exactly when we need to catch a subscription the browser dropped while it was backgrounded.
    const runPass = async () => {
      await refresh();
      const result = await reconcile();
      if (cancelled) return;
      if (result === 'healed') {
        await refresh(); // the refresh above saw "off"; flip the toggle back on
      } else if (result === 'failed') {
        setStatus('Could not restore notifications, tap to retry');
      }
    };
    void runPass();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void runPass();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
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
