// Deep-link focus for ?card=<id>. The URL shape /?card=<id> is an EXTERNAL contract owned by
// bin/relay.mjs (it hard-codes and validates that exact form when auto-opening after a draft push) —
// do not move card addressing to a hash or path route.
//
// claimFocus fires at most ONCE for the whole session (module-level guard), regardless of whether
// the matching card arrived via the initial feed render or a later SSE card-created event.

export const focusCardId: string | null = new URLSearchParams(window.location.search).get('card');

let handled = false;

export function claimFocus(id: string): boolean {
  if (handled || !focusCardId || id !== focusCardId) return false;
  handled = true;
  return true;
}
