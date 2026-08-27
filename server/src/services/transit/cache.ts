const CACHE_MAX = 200;
const entries = new Map<string, { storedAt: number; value: unknown }>();

export function getTransitCache<T>(key: string, ttlMs: number): T | null {
  const entry = entries.get(key);
  if (!entry) return null;
  if (Date.now() - entry.storedAt > ttlMs) {
    entries.delete(key);
    return null;
  }
  return entry.value as T;
}

export function setTransitCache(key: string, value: unknown): void {
  if (entries.size >= CACHE_MAX) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  entries.set(key, { storedAt: Date.now(), value });
}

export function clearTransitCache(prefix?: string): void {
  if (!prefix) {
    entries.clear();
    return;
  }
  for (const key of entries.keys()) {
    if (key.startsWith(prefix)) entries.delete(key);
  }
}
