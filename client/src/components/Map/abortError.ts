/**
 * A request we cancelled on purpose (a newer one superseded it) — not a failure.
 * Axios reports it as CanceledError/ERR_CANCELED, a bare fetch as AbortError.
 */
export function isAbortError(err: unknown): boolean {
  const e = err as { name?: string; code?: string } | null
  return e?.name === 'CanceledError' || e?.code === 'ERR_CANCELED' || e?.name === 'AbortError'
}
