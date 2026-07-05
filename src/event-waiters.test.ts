import { test, expect, describe } from 'bun:test';
import { waitForEvents, notifyEventWaiters, eventWaiterCount } from './event-waiters.ts';

describe('event-waiters', () => {
  test('notify fires a parked waiter with hasNew=true', async () => {
    const p = waitForEvents('c1', 5000);
    expect(eventWaiterCount('c1')).toBe(1);
    notifyEventWaiters('c1');
    expect(await p).toBe(true);
    expect(eventWaiterCount('c1')).toBe(0); // cleaned up
  });

  test('notify fires ALL parked waiters for the same card', async () => {
    const a = waitForEvents('c2', 5000);
    const b = waitForEvents('c2', 5000);
    expect(eventWaiterCount('c2')).toBe(2);
    notifyEventWaiters('c2');
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(eventWaiterCount('c2')).toBe(0);
  });

  test('timeout resolves to false and cleans up', async () => {
    const r = await waitForEvents('c3', 30);
    expect(r).toBe(false);
    expect(eventWaiterCount('c3')).toBe(0);
  });

  test('notifying after settle is a harmless no-op', async () => {
    const r = await waitForEvents('c4', 20); // times out
    expect(r).toBe(false);
    expect(() => notifyEventWaiters('c4')).not.toThrow();
    expect(eventWaiterCount('c4')).toBe(0);
  });

  test('notifying an unknown card is a harmless no-op', () => {
    expect(() => notifyEventWaiters('never-waited-on')).not.toThrow();
  });
});
