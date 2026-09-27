// A bounded, process-local cache for confirmed misses. Callers own
// authorization and supply the time at lookup/record boundaries.
export function createBoundedNegativeCache(capacity: number, ttlMs: number) {
  const missing = new Map<string, number>();

  return {
    has(key: string, at: number): boolean {
      for (const [id, expiresAt] of missing) {
        if (expiresAt <= at) {
          missing.delete(id);
        }
      }
      return missing.has(key);
    },
    record(key: string, at: number): void {
      if (missing.size >= capacity) {
        const oldest = missing.keys().next().value;
        if (oldest !== undefined) {
          missing.delete(oldest);
        }
      }
      missing.set(key, at + ttlMs);
    },
  };
}
