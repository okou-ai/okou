// This is a process-local, display-only cache. The caller checks authorization
// before consulting it; only an authoritative missing owner is recorded.
export const WORKFLOW_OWNER_PROFILE_CACHE_LIMIT = 512;
const NEGATIVE_TTL_MS = 60 * 1000;

export function createWorkflowOwnerProfileNegativeCache() {
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
      if (missing.size >= WORKFLOW_OWNER_PROFILE_CACHE_LIMIT) {
        const oldest = missing.keys().next().value;
        if (oldest !== undefined) {
          missing.delete(oldest);
        }
      }
      missing.set(key, at + NEGATIVE_TTL_MS);
    },
  };
}
