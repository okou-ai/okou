export interface PreparedStorageVersion {
  readonly storageId: string;
  readonly versionId: string;
  readonly s3Key: string;
  readonly size: number;
  readonly archiveSize: number;
  readonly fileCount: number;
  readonly message: string | null;
  readonly createdBy: string;
}

export class StorageVersionIdentityConflictError extends Error {
  constructor(readonly versionId: string) {
    super(`Storage version ${versionId} conflicts with prepared metadata`);
    this.name = "StorageVersionIdentityConflictError";
  }
}

export function storageVersionMatches(
  stored: PreparedStorageVersion,
  prepared: PreparedStorageVersion,
): boolean {
  return (
    stored.storageId === prepared.storageId &&
    stored.versionId === prepared.versionId &&
    stored.s3Key === prepared.s3Key &&
    stored.size === prepared.size &&
    stored.archiveSize === prepared.archiveSize &&
    stored.fileCount === prepared.fileCount &&
    stored.message === prepared.message &&
    stored.createdBy === prepared.createdBy
  );
}
