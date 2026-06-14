import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time token comparison. Use this — not `===` — for the WRITE_TOKEN guard so
 * an attacker can't recover the token byte-by-byte from response-time differences.
 */
export function tokensMatch(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
