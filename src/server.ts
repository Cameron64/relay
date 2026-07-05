import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { existsSync } from 'node:fs';
import { pushRoutes } from './routes-push.ts';
import { appRoutes } from './routes-cards.ts';
import { dispatchRoutes } from './routes-dispatch.ts';
import { store } from './store.ts';
import { ensureCardsSchema, cardsReady, sweepExpired } from './cards-store.ts';
import { ensureDispatchSchema, dispatchReady, pruneDispatches } from './dispatch-store.ts';
import { ensureNotifyLogSchema } from './notify-log.ts';
import { broadcast } from './stream.ts';

// Initialize the subscription store (idempotent, non-fatal — see store.ts).
await store.ensureSchema();

// The React frontend is built by Vite to ./dist (see vite.config.ts + `bun run build`). In
// production the server serves that build. If the build is missing, FAIL FAST in production so
// Railway marks the new deploy failed and keeps the previous (working) deploy live — rather than
// serving an API with no frontend. In dev (NODE_ENV != production) we only warn: `bun run dev`
// runs the backend alongside the Vite dev server (`bun run dev:web`), which serves the frontend.
const DIST = './dist';
if (!existsSync(`${DIST}/index.html`)) {
  console.error(`[relay] ${DIST}/index.html not found — run \`bun run build\` to build the frontend.`);
  if (process.env.NODE_ENV === 'production') {
    console.error('[relay] refusing to start in production without a frontend build.');
    process.exit(1);
  }
}

const app = new Hono();

// --- API --------------------------------------------------------------------
// Health check FIRST and DB-free: Railway hits this; it must stay green even if the
// store is briefly unavailable, or a DB hiccup triggers a restart loop.
app.get('/api/health', (c) => c.json({ ok: true }));

// Card-store schema init: deliberately AFTER /api/health is registered, and wrapped so a
// storage failure cannot abort module load / prevent `export default` (that would mean the
// health route never serves and Railway restart-loops). On failure it's surfaced loudly here
// AND card routes return 503 via cardsReady() — never silently swallowed.
try {
  ensureCardsSchema();
} catch {
  console.error('[relay] cards schema init failed — card routes will 503 until storage recovers');
}

// Dispatch-store schema init: same product-critical treatment as cards (see the warning in
// dispatch-store.ts's ensureDispatchSchema) — failure here 503s the dispatch routes, never the
// process boot / health check.
try {
  ensureDispatchSchema();
} catch {
  console.error('[relay] dispatch schema init failed — dispatch routes will 503 until storage recovers');
}

// Notification audit log: best-effort init (it degrades silently — see notify-log.ts). A failure
// here only disables /api/notifications; push delivery and the card feed are unaffected.
ensureNotifyLogSchema();

app.route('/api', pushRoutes); // -> /api/push/*, /api/notify
app.route('/api', appRoutes); // -> /api/unlock, /api/stream, /api/cards/*
app.route('/api', dispatchRoutes); // -> /api/dispatches/*, /api/dispatch-targets

// --- expiry sweep -----------------------------------------------------------
// Cards carry an expires_at (explicit --ttl, or a kind-based default — see cards-store.ts). This
// interval deletes any that have lapsed and broadcasts card-removed so open tabs drop them live.
// Unref'd so it never keeps the process alive on its own (the server's listener does that).
const SWEEP_MS = Number(process.env.CARD_SWEEP_MS ?? 60_000);
if (SWEEP_MS > 0) {
  const timer = setInterval(() => {
    if (!cardsReady()) return;
    try {
      for (const id of sweepExpired()) void broadcast('card-removed', { id });
    } catch (err) {
      console.error('[relay] expiry sweep failed:', err);
    }
    // Dispatch retention piggybacks on the same interval rather than a second scheduler (master
    // doc §1's spirit: one mechanism, not two). No broadcast on prune — pruned rows are already
    // terminal (done/failed/cancelled) and long past any client caring about their removal.
    if (dispatchReady()) {
      try {
        pruneDispatches();
      } catch (err) {
        console.error('[relay] dispatch retention sweep failed:', err);
      }
    }
  }, SWEEP_MS);
  (timer as { unref?: () => void }).unref?.();
}

// --- PWA control files ------------------------------------------------------
// Served explicitly (not via serveStatic) so we can set the headers a PWA needs:
//   - no-cache so browsers always re-check for a new SW / manifest on reload
//   - Service-Worker-Allowed: / lets the worker control the entire origin
//   - the correct content-types (a SW served as text/html will not register)
// The SW is emitted by vite-plugin-pwa to dist/service-worker.js — the SAME url existing clients
// are registered against, so they upgrade in place.
app.get('/service-worker.js', () =>
  new Response(Bun.file(`${DIST}/service-worker.js`), {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Service-Worker-Allowed': '/',
    },
  }),
);

app.get('/manifest.webmanifest', () =>
  new Response(Bun.file(`${DIST}/manifest.webmanifest`), {
    headers: {
      'Content-Type': 'application/manifest+json',
      'Cache-Control': 'no-cache',
    },
  }),
);

// --- App shell + static assets ----------------------------------------------
app.get('/', () =>
  new Response(Bun.file(`${DIST}/index.html`), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  }),
);

// Hashed JS/CSS bundles, icons/, offline.html — everything else under the Vite build.
app.get('*', serveStatic({ root: DIST }));

const port = Number(process.env.PORT) || 3000;
console.log(`[relay] listening on :${port}`);

// Bun-native serve: exporting { port, fetch } makes `bun run src/server.ts` start the
// server and bind $PORT (Railway injects it). Do NOT add @hono/node-server here — that's
// the Node adapter and is wrong under Bun.
export default { port, fetch: app.fetch };
