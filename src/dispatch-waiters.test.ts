import { test, expect, describe } from 'bun:test';
import { waitForDispatch, notifyDispatchWaiters, dispatchWaiterCount } from './dispatch-waiters.ts';

describe('dispatch-waiters', () => {
  test('notify fires a parked waiter with hasNew=true', async () => {
    const p = waitForDispatch(5000);
    expect(dispatchWaiterCount()).toBe(1);
    notifyDispatchWaiters();
    expect(await p).toBe(true);
    expect(dispatchWaiterCount()).toBe(0); // cleaned up
  });

  test('notify fires ALL parked waiters at once (global queue, not per-id)', async () => {
    const a = waitForDispatch(5000);
    const b = waitForDispatch(5000);
    expect(dispatchWaiterCount()).toBe(2);
    notifyDispatchWaiters();
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(dispatchWaiterCount()).toBe(0);
  });

  test('timeout resolves to false and cleans up', async () => {
    const r = await waitForDispatch(30);
    expect(r).toBe(false);
    expect(dispatchWaiterCount()).toBe(0);
  });

  test('notifying after settle is a harmless no-op', async () => {
    const r = await waitForDispatch(20); // times out
    expect(r).toBe(false);
    expect(() => notifyDispatchWaiters()).not.toThrow();
    expect(dispatchWaiterCount()).toBe(0);
  });

  test('notifying with nobody parked is a harmless no-op', () => {
    expect(() => notifyDispatchWaiters()).not.toThrow();
  });
});
