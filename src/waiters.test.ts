import { test, expect, describe } from 'bun:test';
import { waitForResponse, resolveWaiters, waiterCount, waitForResponseOrEvent } from './waiters.ts';
import { notifyEventWaiters, eventWaiterCount } from './event-waiters.ts';
import type { CardResponse } from './cards-store.ts';

const resp = (verdict: string): CardResponse => ({ verdict, action: verdict, note: null, at: new Date().toISOString() });

describe('waiters', () => {
  test('resolve fires a parked waiter with the response', async () => {
    const p = waitForResponse('c1', 5000);
    expect(waiterCount('c1')).toBe(1);
    resolveWaiters('c1', resp('approved'));
    const r = await p;
    expect(r?.verdict).toBe('approved');
    expect(waiterCount('c1')).toBe(0); // cleaned up
  });

  test('resolve fires ALL parked waiters for the same card', async () => {
    const a = waitForResponse('c2', 5000);
    const b = waitForResponse('c2', 5000);
    expect(waiterCount('c2')).toBe(2);
    resolveWaiters('c2', resp('changes_requested'));
    expect((await a)?.verdict).toBe('changes_requested');
    expect((await b)?.verdict).toBe('changes_requested');
    expect(waiterCount('c2')).toBe(0);
  });

  test('timeout resolves to null and cleans up', async () => {
    const r = await waitForResponse('c3', 30);
    expect(r).toBeNull();
    expect(waiterCount('c3')).toBe(0);
  });

  test('resolving after settle is a harmless no-op', async () => {
    const r = await waitForResponse('c4', 20); // times out
    expect(r).toBeNull();
    expect(() => resolveWaiters('c4', resp('approved'))).not.toThrow();
    expect(waiterCount('c4')).toBe(0);
  });
});

// Plan 04: composed race between this module's verdict waiters and event-waiters.ts's card_events
// waiters — the mechanism the /response route uses when a caller opts in with ?events_since=N.
describe('waitForResponseOrEvent', () => {
  test('resolves "responded" when the verdict lands first', async () => {
    const p = waitForResponseOrEvent('t1', 5000);
    resolveWaiters('t1', resp('approved')); // resolving the verdict waiter cleans IT up immediately
    const r = await p;
    expect(r.kind).toBe('responded');
    if (r.kind === 'responded') expect(r.resp.verdict).toBe('approved');
    expect(waiterCount('t1')).toBe(0);
    // The composed event-side waiter is still parked, self-cleaning on its own 5s timeout — the
    // outer race settling doesn't cancel it (see the module comment); nothing to assert here.
  });

  test('resolves "event" when a new card_event lands first', async () => {
    const p = waitForResponseOrEvent('t2', 5000);
    notifyEventWaiters('t2'); // resolving the event waiter cleans IT up immediately
    const r = await p;
    expect(r.kind).toBe('event');
    expect(eventWaiterCount('t2')).toBe(0);
    // The composed verdict-side waiter is still parked, self-cleaning on its own 5s timeout.
  });

  test('resolves "pending" once both underlying waits time out with nothing new', async () => {
    const r = await waitForResponseOrEvent('t3', 30);
    expect(r.kind).toBe('pending');
    expect(waiterCount('t3')).toBe(0);
  });

  test('a verdict landing after an unrelated event notify for the SAME card still resolves "event" first (whichever fires first wins)', async () => {
    // Simulates: agent is polling with events_since set, the human asks a question (fires first),
    // then later answers (a second, later resolveWaiters call is a no-op against this settled poll).
    const p = waitForResponseOrEvent('t4', 5000);
    notifyEventWaiters('t4');
    const r = await p;
    expect(r.kind).toBe('event');
    resolveWaiters('t4', resp('approved')); // harmless no-op — this poll already settled
  });
});
