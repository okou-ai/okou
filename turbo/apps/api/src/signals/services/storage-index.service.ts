import { and, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  memberMemories,
  memoryVersions,
} from "@okouai/db/schema/member-memory";
import { MEMORY_ARTIFACT_NAME } from "@okouai/core/storage-names";
import { systemStoragePresignedUrlCache } from "@okouai/db/runtime/system-storage-presigned-url-cache";
import {
  storageVersionCacheKeySql,
  cacheRowsFromProjection,
  type ExecutionStorageCacheRows,
} from "./execution-storage-cache-read.service";

export interface StorageLookup {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
}
export interface StorageRequest {
  readonly lookup: StorageLookup;
  readonly version: string | undefined;
}
export interface StorageVersionIndexEntry {
  readonly id: string;
  readonly s3Key: string;
  readonly archiveSize: number;
  readonly fileCount: number;
}
export interface StorageIndexEntry {
  readonly storageId: string;
  readonly headVersionId: string | null;
  readonly headVersion: StorageVersionIndexEntry | null;
  readonly exactVersions: ReadonlyMap<string, StorageVersionIndexEntry>;
  readonly cachedUrls?: ExecutionStorageCacheRows;
}
export type StorageIndex = ReadonlyMap<string, StorageIndexEntry>;
export function storageIndexKey(
  orgId: string,
  userId: string,
  name: string,
): string {
  return JSON.stringify([orgId, userId, name]);
}
export function storageRequestKey(request: StorageRequest): string {
  return JSON.stringify([
    request.lookup.orgId,
    request.lookup.userId,
    request.lookup.name,
    request.version ?? "latest",
  ]);
}
export function isFullStorageVersionId(version: string): boolean {
  return /^[0-9a-f]{64}$/i.test(version);
}
const head = alias(memoryVersions, "head_storage_versions");
const exact = alias(memoryVersions, "exact_storage_versions");

function uniqueStorageRequests(requests: readonly StorageRequest[]) {
  return [
    ...new Map(
      requests.map((request) => {
        const exactVersionId =
          request.version !== undefined &&
          isFullStorageVersionId(request.version)
            ? request.version
            : null;
        return [
          JSON.stringify([
            request.lookup.orgId,
            request.lookup.userId,
            request.lookup.name,
            exactVersionId,
          ]),
          { lookup: request.lookup, exactVersionId },
        ];
      }),
    ).values(),
  ];
}

function requestedVersionCacheKeySql() {
  return storageVersionCacheKeySql({
    orgId: sql`${memberMemories.orgId}`,
    versionId: sql`CASE WHEN requested.version_id IS NULL OR requested.version_id = ${head.id} THEN ${head.id} ELSE ${exact.id} END`,
    s3Key: sql`CASE WHEN requested.version_id IS NULL OR requested.version_id = ${head.id} THEN ${head.objectPrefix} ELSE ${exact.objectPrefix} END`,
  });
}

/** Memory owns pre-queue selection; wire/cache keys retain their existing identity. */
export function storageBaseIndexReadPlan(requests: readonly StorageRequest[]) {
  const unique = uniqueStorageRequests(requests);
  if (unique.length === 0) {
    return null;
  }
  return {
    columns: {
      orgId: memberMemories.orgId,
      userId: memberMemories.userId,
      name: sql`${MEMORY_ARTIFACT_NAME}`.mapWith(memberMemories.userId),
      storageId: memberMemories.id,
      headVersionId: memberMemories.headVersionId,
      headId: head.id,
      headS3Key: head.objectPrefix,
      headArchiveSize: head.archiveSize,
      headFileCount: head.fileCount,
      exactId: exact.id,
      exactS3Key: exact.objectPrefix,
      exactArchiveSize: exact.archiveSize,
      exactFileCount: exact.fileCount,
      cacheKey: systemStoragePresignedUrlCache.cacheKey,
      cacheScope: systemStoragePresignedUrlCache.scope,
      presignedUrl: systemStoragePresignedUrlCache.presignedUrl,
      expiresAt: systemStoragePresignedUrlCache.expiresAt,
    },
    from: memberMemories,
    requested: sql`unnest(
    ${sql.param(
      unique.map((request) => {
        return request.lookup.orgId;
      }),
    )}::text[],
    ${sql.param(
      unique.map((request) => {
        return request.lookup.userId;
      }),
    )}::text[],
    ${sql.param(
      unique.map((request) => {
        return request.lookup.name;
      }),
    )}::varchar(256)[],
    ${sql.param(
      unique.map((request) => {
        return request.exactVersionId;
      }),
    )}::varchar(64)[]
  ) AS requested(org_id, user_id, name, version_id)`,
    requestedCondition: and(
      eq(memberMemories.orgId, sql`requested.org_id`),
      eq(memberMemories.userId, sql`requested.user_id`),
      eq(sql`${MEMORY_ARTIFACT_NAME}`, sql`requested.name`),
    ),
    head,
    headCondition: and(
      eq(memberMemories.headVersionId, head.id),
      eq(head.memoryId, memberMemories.id),
    ),
    exact,
    exactCondition: and(
      eq(
        exact.id,
        sql`NULLIF(requested.version_id, ${memberMemories.headVersionId})`,
      ),
      eq(exact.memoryId, memberMemories.id),
    ),
    cache: systemStoragePresignedUrlCache,
    cacheCondition: eq(
      systemStoragePresignedUrlCache.cacheKey,
      requestedVersionCacheKeySql(),
    ),
  };
}

interface StorageBaseIndexRow {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly storageId: string;
  readonly headVersionId: string | null;
  readonly headId: string | null;
  readonly headS3Key: string | null;
  readonly headArchiveSize: number | null;
  readonly headFileCount: number | null;
  readonly exactId: string | null;
  readonly exactS3Key: string | null;
  readonly exactArchiveSize: number | null;
  readonly exactFileCount: number | null;
  readonly cacheKey: string | null;
  readonly cacheScope: string | null;
  readonly presignedUrl: string | null;
  readonly expiresAt: Date | null;
}

export function storageBaseIndexFromRows(
  rows: readonly StorageBaseIndexRow[],
): StorageIndex {
  const versions = new Map<string, Map<string, StorageVersionIndexEntry>>();
  for (const row of rows) {
    if (
      row.exactId === null ||
      row.exactS3Key === null ||
      row.exactArchiveSize === null ||
      row.exactFileCount === null
    ) {
      continue;
    }
    const entries =
      versions.get(row.storageId) ??
      new Map<string, StorageVersionIndexEntry>();
    entries.set(row.exactId, {
      id: row.exactId,
      s3Key: row.exactS3Key,
      archiveSize: row.exactArchiveSize,
      fileCount: row.exactFileCount,
    });
    versions.set(row.storageId, entries);
  }
  const index = new Map<string, StorageIndexEntry>();
  for (const row of rows) {
    index.set(storageIndexKey(row.orgId, row.userId, row.name), {
      storageId: row.storageId,
      headVersionId: row.headVersionId,
      headVersion:
        row.headId &&
        row.headS3Key &&
        row.headArchiveSize !== null &&
        row.headFileCount !== null
          ? {
              id: row.headId,
              s3Key: row.headS3Key,
              archiveSize: row.headArchiveSize,
              fileCount: row.headFileCount,
            }
          : null,
      exactVersions:
        versions.get(row.storageId) ??
        new Map<string, StorageVersionIndexEntry>(),
      cachedUrls: [
        ...(index.get(storageIndexKey(row.orgId, row.userId, row.name))
          ?.cachedUrls ?? []),
        ...cacheRowsFromProjection(row),
      ],
    });
  }
  return index;
}

export function mergeStorageIndexes(
  left: StorageIndex,
  right: StorageIndex,
): StorageIndex {
  const merged = new Map(left);
  for (const [key, entry] of right) {
    const previous = merged.get(key);
    merged.set(
      key,
      previous
        ? {
            ...entry,
            exactVersions: new Map([
              ...previous.exactVersions,
              ...entry.exactVersions,
            ]),
            cachedUrls: [
              ...(previous.cachedUrls ?? []),
              ...(entry.cachedUrls ?? []),
            ],
          }
        : entry,
    );
  }
  return merged;
}
