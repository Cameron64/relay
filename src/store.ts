// Subscription store — DEFAULT backend: SQLite via Bun's built-in `bun:sqlite`.
//
// Why SQLite-on-a-volume is the default (not Postgres): zero extra Railway service, no
// DATABASE_URL injection / SSL / public-vs-private-host dance, and it ships with Bun.
// Persist across deploys by attaching a Railway volume (see references/storage-and-stacks.md).
// If no volume is attached the app still runs — subscriptions just live in an ephemeral
// ./.data/app.db, a SAFE degrade (Postgres would boot-crash on a missing DATABASE_URL).
//
// `db` and `resolveDbPath` are EXPORTED so feature modules (e.g. cards-store.ts) reuse the
// single open connection. bun:sqlite is single-connection-per-file; opening a second
// `new Database(samePath)` invites SQLITE_BUSY. Import `db` from here — never re-open.

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type StoredSubscription = {
  endpoint: string;
  p256dh: string;
  auth: string;
  userLabel?: string | null;
};

export interface SubscriptionStore {
  ensureSchema(): Promise<void>;
  upsert(sub: StoredSubscription): Promise<void>;
  remove(endpoint: string): Promise<void>;
  all(): Promise<StoredSubscription[]>;
  /** Number of stored subscriptions — backs the read-only /api/push/count status endpoint. */
  count(): Promise<number>;
  /** Delete endpoints the push service reported gone (404/410). */
  pruneExpired(endpoints: string[]): Promise<void>;
  /** Stamp last_sent_at on everything except the just-pruned endpoints. */
  markSent(excludeEndpoints: string[]): Promise<void>;
}

export function resolveDbPath(): string {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  const mount = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  return mount ? join(mount, 'app.db') : join('.', '.data', 'app.db');
}

const dbPath = resolveDbPath();
// An in-memory DB (used by the test suite via DB_PATH=:memory:) has no directory to create;
// mkdirSync('.', {recursive}) also throws EEXIST under Bun on Windows, so skip it.
if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
export const db = new Database(dbPath);
db.exec('PRAGMA journal_mode = WAL;');

export const store: SubscriptionStore = {
  async ensureSchema() {
    // Non-fatal: a transient failure here must not crash the process / fail the
    // health check (which would put Railway into a restart loop). Log and move on.
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          endpoint      TEXT PRIMARY KEY,
          p256dh        TEXT NOT NULL,
          auth          TEXT NOT NULL,
          user_label    TEXT,
          failure_count INTEGER NOT NULL DEFAULT 0,
          created_at    TEXT NOT NULL DEFAULT (datetime('now')),
          last_sent_at  TEXT
        );
      `);
    } catch (err) {
      console.error('[store] ensureSchema failed (continuing degraded):', err);
    }
  },

  async upsert(sub) {
    db.query(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_label)
       VALUES ($endpoint, $p256dh, $auth, $userLabel)
       ON CONFLICT(endpoint) DO UPDATE SET
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         failure_count = 0`,
    ).run({
      $endpoint: sub.endpoint,
      $p256dh: sub.p256dh,
      $auth: sub.auth,
      $userLabel: sub.userLabel ?? null,
    });
  },

  async remove(endpoint) {
    db.query('DELETE FROM push_subscriptions WHERE endpoint = $endpoint').run({ $endpoint: endpoint });
  },

  async all() {
    return db
      .query('SELECT endpoint, p256dh, auth, user_label AS userLabel FROM push_subscriptions')
      .all() as StoredSubscription[];
  },

  async count() {
    const row = db.query('SELECT COUNT(*) AS n FROM push_subscriptions').get() as { n: number };
    return row.n;
  },

  async pruneExpired(endpoints) {
    if (endpoints.length === 0) return;
    const placeholders = endpoints.map((_, i) => `$e${i}`).join(', ');
    const params = Object.fromEntries(endpoints.map((e, i) => [`$e${i}`, e]));
    db.query(`DELETE FROM push_subscriptions WHERE endpoint IN (${placeholders})`).run(params);
  },

  async markSent(excludeEndpoints) {
    const now = new Date().toISOString();
    if (excludeEndpoints.length === 0) {
      db.query('UPDATE push_subscriptions SET last_sent_at = $now').run({ $now: now });
      return;
    }
    const placeholders = excludeEndpoints.map((_, i) => `$e${i}`).join(', ');
    const params: Record<string, string> = { $now: now };
    excludeEndpoints.forEach((e, i) => (params[`$e${i}`] = e));
    db.query(`UPDATE push_subscriptions SET last_sent_at = $now WHERE endpoint NOT IN (${placeholders})`).run(
      params,
    );
  },
};
