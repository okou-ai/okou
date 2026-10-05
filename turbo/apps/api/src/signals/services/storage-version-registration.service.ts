import { storageVersions } from "@okouai/db/schema/storage";
import { inArray } from "drizzle-orm";

import type { Db } from "../external/db";

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

export async function registerPreparedStorageVersions(
  args: {
    readonly db: Db;
    readonly versions: readonly PreparedStorageVersion[];
  },
  signal: AbortSignal,
): Promise<ReadonlySet<string>> {
  if (args.versions.length === 0) {
    return new Set();
  }

  const inserted = await args.db
    .insert(storageVersions)
    .values(
      args.versions.map((version) => {
        return {
          id: version.versionId,
          storageId: version.storageId,
          s3Key: version.s3Key,
          size: version.size,
          archiveSize: version.archiveSize,
          fileCount: version.fileCount,
          message: version.message,
          createdBy: version.createdBy,
        };
      }),
    )
    .onConflictDoNothing()
    .returning({ versionId: storageVersions.id });
  signal.throwIfAborted();

  const stored = await args.db
    .select({
      storageId: storageVersions.storageId,
      versionId: storageVersions.id,
      s3Key: storageVersions.s3Key,
      size: storageVersions.size,
      archiveSize: storageVersions.archiveSize,
      fileCount: storageVersions.fileCount,
      message: storageVersions.message,
      createdBy: storageVersions.createdBy,
    })
    .from(storageVersions)
    .where(
      inArray(
        storageVersions.id,
        args.versions.map((version) => {
          return version.versionId;
        }),
      ),
    );
  signal.throwIfAborted();

  const storedByVersionId = new Map(
    stored.map((version) => {
      return [version.versionId, version] as const;
    }),
  );
  for (const prepared of args.versions) {
    const existing = storedByVersionId.get(prepared.versionId);
    if (!existing || !storageVersionMatches(existing, prepared)) {
      throw new StorageVersionIdentityConflictError(prepared.versionId);
    }
  }

  return new Set(
    inserted.map((version) => {
      return version.versionId;
    }),
  );
}
