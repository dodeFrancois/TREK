/**
 * The single upstream contract both transit providers honour: one timeout, one
 * response-size ceiling, and the `status` values transit.controller.ts relays
 * verbatim (it does `err.status || 502`).
 *
 * Kept as plain functions rather than a provider: there is no state here, and
 * the pure NAVITIME mappers must stay callable without a DI container.
 */

// A plan response with eight geometry-carrying itineraries stays well under a
// megabyte; anything bigger is a misbehaving provider, not data we want to map.
const MAX_RESPONSE_BYTES = 5_000_000;
const UPSTREAM_TIMEOUT_MS = 8000;

function statusError(message: string, status: number): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

/** 400 — the caller sent something unusable. */
export function badRequest(message: string): Error & { status: number } {
  return statusError(message, 400);
}

/** 503 — the configured provider has no usable credentials. Refuse, never degrade. */
export function notConfigured(message: string): Error & { status: number } {
  return statusError(message, 503);
}

/** A 429 upstream stays a 429 so the client can back off; everything else is a 502. */
export function upstreamFailure(message: string, httpStatus: number): Error & { status: number } {
  return statusError(message, httpStatus === 429 ? 429 : 502);
}

export async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) throw upstreamFailure(`Transit provider error (HTTP ${res.status})`, res.status);
  const length = Number(res.headers?.get('content-length') ?? 0);
  if (length > MAX_RESPONSE_BYTES) {
    throw statusError('Transit provider error (response too large)', 502);
  }
  return res.json();
}
