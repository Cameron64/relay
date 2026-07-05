// Deep-link focus for ?card=<id>. The URL shape /?card=<id> is an EXTERNAL contract owned by
// bin/relay.mjs (it hard-codes and validates that exact form when auto-opening after a draft push) —
// do not move card addressing to a hash or path route.
//
// claimFocus fires at most ONCE per deep-link entry: the first matching card (whether it arrived via
// the initial feed render or a later SSE card-created event) scrolls into view, then we strip the
// ?card= (and &reply=) params from the URL. That makes the scroll a one-time event on entry rather
// than on every load — without it, a manual refresh / PWA relaunch reloads this module (resetting
// the in-memory guard) with the param still present and re-scrolls to the card every single time.
//
// replyRequested mirrors the notification "Reply" tap (/?card=<id>&reply=1): a prompt card so
// deep-linked auto-focuses its reply composer so the mobile keyboard pops straight away.

export const focusCardId: string | null = new URLSearchParams(window.location.search).get('card');
export const replyRequested: boolean = new URLSearchParams(window.location.search).get('reply') === '1';

// Scroll an already-rendered card into view by id. CardView sets data-id={card.id} on its MCard
// root, so this is a plain in-page DOM lookup — no routing needed. Shared by DispatchItem's "View
// result" button and SessionsPanel's "Answer it" action (relay-roadmap Plan 03), both of which
// jump to a card that's already in the SAME feed rather than duplicating its content.
export function scrollToCard(cardId: string): void {
  const el = document.querySelector(`[data-id="${cardId}"]`);
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

let handled = false;

export function claimFocus(id: string): boolean {
  if (handled || !focusCardId || id !== focusCardId) return false;
  handled = true;
  // Consume the deep-link. focusCardId was already captured at module load, so this load still
  // scrolls; subsequent reloads see a bare URL and skip the scroll.
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('card');
    url.searchParams.delete('reply');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  } catch {
    /* replaceState can throw in rare sandboxed contexts; the scroll already happened */
  }
  return true;
}
