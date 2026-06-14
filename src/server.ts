import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { pushRoutes } from './routes-push.ts';
import { appRoutes } from './routes-cards.ts';
import { store } from './store.ts';
import { ensureCardsSchema } from './cards-store.ts';

// Initialize the subscription store (idempotent, non-fatal — see store.ts).
await store.ensureSchema();

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

app.route('/api', pushRoutes); // -> /api/push/*, /api/notify
app.route('/api', appRoutes); // -> /api/unlock, /api/stream, /api/cards/*

// --- PWA control files ------------------------------------------------------
// Served explicitly (not via serveStatic) so we can set the headers a PWA needs:
//   - no-cache so browsers always re-check for a new SW / manifest on reload
//   - Service-Worker-Allowed: / lets the worker control the entire origin
//   - the correct content-types (a SW served as text/html will not register)
app.get('/service-worker.js', () =>
  new Response(Bun.file('./public/service-worker.js'), {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Service-Worker-Allowed': '/',
    },
  }),
);

app.get('/manifest.webmanifest', () =>
  new Response(Bun.file('./public/manifest.webmanifest'), {
    headers: {
      'Content-Type': 'application/manifest+json',
      'Cache-Control': 'no-cache',
    },
  }),
);

// --- App shell + static assets ----------------------------------------------
app.get('/', () =>
  new Response(Bun.file('./public/index.html'), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  }),
);

// icons/, offline.html, push-client.js, app.js, app.css, vendor/, anything else under public/.
app.get('*', serveStatic({ root: './public' }));

const port = Number(process.env.PORT) || 3000;
console.log(`[relay] listening on :${port}`);

// Bun-native serve: exporting { port, fetch } makes `bun run src/server.ts` start the
// server and bind $PORT (Railway injects it). Do NOT add @hono/node-server here — that's
// the Node adapter and is wrong under Bun.
export default { port, fetch: app.fetch };
