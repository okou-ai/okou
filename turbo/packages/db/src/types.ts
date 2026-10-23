export type ArtifactMissingRootPolicy = "fail" | "preserveParentVersion";

/**
 * Canonical Storage mount for Run execution and storage preparation.
 *
 * Preparation inputs may omit `version` to resolve current HEAD. Accepted Run
 * snapshots retain the exact resolved version.
 */
export interface PersistedStorageMount {
  orgId: string;
  userId: string;
  name: string;
  storageId: string;
  version?: string;
  mountPath: string;
  optional?: boolean;
  writeback?: boolean;
  missingRootPolicy?: ArtifactMissingRootPolicy;
}
