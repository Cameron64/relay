import webpush from 'web-push';
import { store, type StoredSubscription } from './store.ts';

// Web Push sender. VAPID keys come from env (generate once with
// `npx web-push generate-vapid-keys`). If they're absent the module degrades to a
// no-op so the app still boots in an unconfigured/dev env — push is simply disabled.

export type PushPayload = {
  title: string;
  body: string;
  url?: string; // where notificationclick takes the user (default '/')
  tag?: string; // collapse key — a later notification with the same tag replaces the earlier
};

let configured: boolean | null = null;

function ensureConfigured(): boolean {
  if (configured !== null) return configured;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:you@example.com';
  if (!publicKey || !privateKey) {
    console.warn('[push] VAPID keys not configured — push notifications disabled');
    configured = false;
    return false;
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  return true;
}

export function isPushConfigured(): boolean {
  return ensureConfigured();
}

export function getPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY || null;
}

export type SendResult = {
  sent: number;
  failed: number;
  /** Endpoints the push service reported as gone (404/410) — caller should delete. */
  expiredEndpoints: string[];
};

/**
 * Pure send: pushes `payload` to every given subscription and reports per-endpoint
 * outcomes. No store access, so it's unit-testable against mock endpoints. A 404/410
 * means the subscription is permanently gone; its endpoint is returned for pruning.
 */
export async function sendToSubscriptions(
  subscriptions: StoredSubscription[],
  payload: PushPayload,
): Promise<SendResult> {
  if (!ensureConfigured()) {
    return { sent: 0, failed: subscriptions.length, expiredEndpoints: [] };
  }

  const data = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url ?? '/',
    tag: payload.tag ?? 'relay',
  });

  const result: SendResult = { sent: 0, failed: 0, expiredEndpoints: [] };

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          data,
          { TTL: 60 * 60 * 24 }, // hold up to 24h if the device is offline
        );
        result.sent++;
      } catch (error) {
        result.failed++;
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          result.expiredEndpoints.push(sub.endpoint);
        } else {
          console.error(`[push] send failed (${statusCode ?? 'no status'}) for ${sub.endpoint}`);
        }
      }
    }),
  );

  return result;
}

/**
 * Load every stored subscription, push to all, and prune any the push service reported
 * as gone. Returns counts plus the subscription total at send time.
 */
export async function sendPushToAll(payload: PushPayload): Promise<SendResult & { total: number }> {
  const subs = await store.all();
  const result = await sendToSubscriptions(subs, payload);

  if (result.expiredEndpoints.length > 0) {
    await store.pruneExpired(result.expiredEndpoints);
  }
  if (result.sent > 0) {
    await store.markSent(result.expiredEndpoints);
  }

  return { ...result, total: subs.length };
}
