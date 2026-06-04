// src/lib/service-auth.ts
// AF-53: constant-time bearer-token auth for the `af serve` HTTP service.
//
// Mirrors the timing-safe comparison pattern in src/lib/webhook-handler.ts:
// the bearer token is compared to the configured secret with
// crypto.timingSafeEqual — never `===`. Kept pure (no req/res) so later
// tickets (AF-56/AF-69) can reuse it as middleware and tests can hit it directly.

import { timingSafeEqual } from 'crypto';

/**
 * Constant-time string comparison. Returns false (without leaking length via
 * an early `===`) when lengths differ, otherwise the timingSafeEqual result.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  if (ab.length !== bb.length) return false;
  try {
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

/**
 * Extract the token from an `Authorization: Bearer <token>` header value.
 * Returns undefined when the header is missing or not a Bearer scheme.
 */
export function parseBearer(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : undefined;
}

/**
 * Authorize a request given its Authorization header value and the configured
 * secret. Constant-time. Returns true only when a Bearer token is present and
 * matches the secret. A missing or wrong token → false (→ 401 at the caller).
 *
 * `secret` is assumed non-empty (the command refuses to start without one).
 */
export function isAuthorized(
  authorizationHeader: string | string[] | undefined,
  secret: string,
): boolean {
  if (!secret) return false;
  const token = parseBearer(authorizationHeader);
  if (token === undefined) return false;
  return constantTimeEqual(token, secret);
}
