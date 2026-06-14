// SSE hub — the live feed transport. Every open PWA tab holds one /api/stream connection;
// when a card is created or answered, broadcast() pushes the event so the UI updates without
// polling (this is the "present on desktop instantly" half of the bridge).
//
// Dead connections are pruned by the route's explicit stream.onAbort() (see routes-cards.ts)
// — we do NOT rely on write failures alone. broadcast() also drops a client whose write
// throws, as a belt-and-suspenders cleanup. hubSize() is logged on heartbeat for observability.

import type { SSEStreamingApi } from 'hono/streaming';

const clients = new Map<number, SSEStreamingApi>();
let nextId = 1;

export function addClient(stream: SSEStreamingApi): number {
  const id = nextId++;
  clients.set(id, stream);
  return id;
}

export function removeClient(id: number): void {
  clients.delete(id);
}

export function hubSize(): number {
  return clients.size;
}

export async function broadcast(event: string, data: unknown): Promise<void> {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  for (const [id, stream] of [...clients]) {
    try {
      await stream.writeSSE({ event, data: payload });
    } catch {
      clients.delete(id);
    }
  }
}
