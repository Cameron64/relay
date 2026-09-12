import { createHash } from 'node:crypto';
import { db } from './store.ts';
import { cardsReady, createCard, getCard } from './cards-store.ts';
import { broadcast } from './stream.ts';
import { isPushConfigured, sendPushToAll } from './push.ts';

export type ComputeCompletion = {
  public_id: string; status: string; placement: { host: string };
  result: { receipt_id: string; summary: { algorithm: string; digest: string; rounds: number; chunk_bytes: number } };
};

export function ensureComputeNotificationsSchema() {
  // Receipt mappings outlive expiring cards: replay must never recreate a dismissed/expired card.
  db.exec(`CREATE TABLE IF NOT EXISTS compute_notification_receipts (
    receipt_id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL,
    card_id TEXT NOT NULL, created_at TEXT NOT NULL
  )`);
}

export function recordComputeCompletion(job: ComputeCompletion): { card_id: string; created: boolean } {
  const result = job.result;
  if (job.status !== 'succeeded' || !result || !/^[a-zA-Z0-9_-]{1,128}$/.test(job.public_id) ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(result.receipt_id) || !['cloudripper', 'current-windows'].includes(job.placement.host) ||
    result.summary.algorithm !== 'sha256' || !/^[a-f0-9]{64}$/.test(result.summary.digest) ||
    ![1000, 10000, 50000].includes(result.summary.rounds) || ![65536, 262144, 1048576].includes(result.summary.chunk_bytes)) {
    throw new Error('Invalid compute completion');
  }
  const hash = createHash('sha256').update(JSON.stringify([job.public_id, job.placement.host, result.receipt_id,
    result.summary.algorithm, result.summary.digest, result.summary.rounds, result.summary.chunk_bytes])).digest('hex');
  return db.transaction(() => {
    const existing = db.query('SELECT job_id, payload_hash, card_id FROM compute_notification_receipts WHERE receipt_id = ?').get(result.receipt_id) as any;
    if (existing) {
      if (existing.job_id !== job.public_id || existing.payload_hash !== hash) throw new Error('Compute receipt conflict');
      return { card_id: existing.card_id, created: false };
    }
    const host = job.placement.host === 'cloudripper' ? 'Cloudripper' : 'Windows';
    const card = createCard({ kind: 'note', title: `Compute complete on ${host}`,
      body: `Your synthetic CPU task finished and its result is saved.\n\nJob: ${job.public_id}\n\nSHA-256: ${result.summary.digest}`,
      buttons: [], options: [], copy_text: result.summary.digest, mermaid: null, page_html: null,
      source: { app: 'personal-compute', job_id: job.public_id, receipt_id: result.receipt_id },
      priority: 'normal', expires_at: null,
    });
    db.query('INSERT INTO compute_notification_receipts (receipt_id, job_id, payload_hash, card_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(result.receipt_id, job.public_id, hash, card.id, new Date().toISOString());
    return { card_id: card.id, created: true };
  })();
}

export async function syncComputeNotifications(url: string, token: string, fetcher: typeof fetch = fetch) {
  const headers = { authorization: `Bearer ${token}` };
  ensureComputeNotificationsSchema();
  const response = await fetcher(`${url}/v1/notifications/pending`, { headers, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) return;
  const payload = await response.json() as { jobs: ComputeCompletion[] };
  for (const job of payload.jobs || []) {
    try {
      const recorded = recordComputeCompletion(job);
      if (recorded.created) {
        const card = getCard(recorded.card_id);
        if (card) {
          await broadcast('card-created', card);
          // Card creation is durable and idempotent. Web Push is best effort; never repeat
          // computation or create another card because the notification network failed.
          if (isPushConfigured()) {
            try { await sendPushToAll({ title: card.title, body: 'Your result is saved in Relay.', url: `/?card=${card.id}`, tag: card.id }); }
            catch { /* The persisted card remains in the feed. */ }
          }
        }
      }
      await fetcher(`${url}/v1/notifications/${encodeURIComponent(job.result.receipt_id)}/ack`, {
        method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(10_000),
      });
    } catch { console.warn('[compute] one result notification could not be synchronized'); }
  }
}

export function startComputeNotifications(): (() => void) | null {
  const url = process.env.COMPUTE_API_URL?.replace(/\/$/, '');
  const token = process.env.COMPUTE_APP_TOKEN;
  if (!url || !token) return null;
  const settings = { url, token };
  let busy = false;
  async function tick() {
    if (busy || !cardsReady()) return;
    busy = true;
    try {
      await syncComputeNotifications(settings.url, settings.token);
    } catch { console.warn('[compute] notification synchronization unavailable'); }
    finally { busy = false; }
  }
  const timer = setInterval(() => void tick(), 5000);
  timer.unref?.();
  void tick();
  return () => clearInterval(timer);
}
