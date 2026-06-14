import { test, expect, describe } from 'bun:test';
import { waitForResponse, resolveWaiters, waiterCount } from './waiters.ts';
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
