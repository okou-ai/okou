// Display-only, process-local negative cache. Authorization is checked by the
// caller before consulting it; expired entries are pruned on lookup.
export const MAX_WORKFLOW_OWNER_PROFILES = 512;
const NEGATIVE_TTL_MS = 60 * 1000;

export function createWorkflowOwnerProfileNegativeCache() {
  const missing = new Map<string, number>();

  return {
    has(ownerUserId: string, at: number): boolean {
      for (const [id, expiresAt] of missing) {
        if (expiresAt <= at) {
          missing.delete(id);
        }
      }
      return missing.has(ownerUserId);
    },
    record(ownerUserId: string, at: number): void {
      if (missing.size >= MAX_WORKFLOW_OWNER_PROFILES) {
        const oldest = missing.keys().next().value;
        if (oldest !== undefined) {
          missing.delete(oldest);
        }
      }
      missing.set(ownerUserId, at + NEGATIVE_TTL_MS);
    },
  };
}
