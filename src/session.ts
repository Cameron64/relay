// Auth for Relay. Two timing-safe tokens:
//   - WRITE_TOKEN  (machine side: CLI + hooks)   — x-write-token header
//   - UI_TOKEN     (browser side)                — exchanged at POST /api/unlock for an
//                                                  httpOnly cookie, also accepted as Bearer
//
// Why a cookie (not localStorage) for the UI: EventSource (SSE) cannot set an Authorization
// header, but it DOES send same-origin cookies automatically — so the cookie is what makes
// /api/stream authable. httpOnly also keeps the token out of reach of any XSS in the page.
//
// The cookie's Secure attribute is CONDITIONAL: omitted on plain http (so the localhost
// smoke test round-trips) and set on Railway HTTPS. Detected via x-forwarded-proto / NODE_ENV.

import type { Context, Next } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { tokensMatch } from './auth.ts';

export const SESSION_COOKIE = 'relay_session';

function uiToken(): string {
  return process.env.UI_TOKEN || '';
}
function writeToken(): string {
  return process.env.WRITE_TOKEN || '';
}

function isSecureRequest(c: Context): boolean {
  return c.req.header('x-forwarded-proto') === 'https' || process.env.NODE_ENV === 'production';
}

export async function handleUnlock(c: Context) {
  const expected = uiToken();
  if (!expected) return c.json({ error: 'server not configured (UI_TOKEN unset)' }, 500);
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  const provided = typeof body?.token === 'string' ? body.token : undefined;
  if (!tokensMatch(provided, expected)) return c.json({ error: 'invalid token' }, 401);
  setCookie(c, SESSION_COOKIE, expected, {
    httpOnly: true,
    secure: isSecureRequest(c),
    sameSite: 'Lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  return c.json({ ok: true });
}

export async function requireUi(c: Context, next: Next) {
  const expected = uiToken();
  if (!expected) return c.json({ error: 'server not configured (UI_TOKEN unset)' }, 500);
  const cookie = getCookie(c, SESSION_COOKIE);
  const authHeader = c.req.header('authorization');
  const bearer = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
  if (tokensMatch(cookie, expected) || tokensMatch(bearer, expected)) return next();
  return c.json({ error: 'unauthorized' }, 401);
}

export async function requireWrite(c: Context, next: Next) {
  const expected = writeToken();
  if (!expected) return c.json({ error: 'server not configured (WRITE_TOKEN unset)' }, 500);
  if (tokensMatch(c.req.header('x-write-token'), expected)) return next();
  return c.json({ error: 'unauthorized' }, 401);
}
