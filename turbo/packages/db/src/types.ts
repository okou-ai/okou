export type ArtifactMissingRootPolicy = "fail" | "preserveParentVersion";

export type PersistedPiMemoryRecallSelection =
  | {
      readonly status: "no-content";
      readonly memoryStorageId: string;
      readonly storageVersionId: string;
    }
  | {
      readonly status: "ready";
      readonly memoryStorageId: string;
      readonly storageVersionId: string;
      readonly content: string;
      readonly sourceHash: string;
      readonly sourceSize: number;
      readonly tokenCount: number;
    };

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
  /** Frozen Pi prompt epoch; API-only metadata, never part of the mount wire. */
  piMemoryRecall?: PersistedPiMemoryRecallSelection;
}
