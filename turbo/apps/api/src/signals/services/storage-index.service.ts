import { and, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { systemStoragePresignedUrlCache } from "@okouai/db/schema/system-storage-presigned-url-cache";
import {
  storageVersionCacheKeySql,
  cacheRowsFromProjection,
  type ExecutionStorageCacheRows,
} from "./execution-storage-cache-read.service";
import type { ReadonlyDb } from "../external/db";
import type { ExecutionStorageRequest } from "./execution-storage.service";

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
  readonly s3Prefix: string;
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
const head = alias(storageVersions, "head_storage_versions");
const exact = alias(storageVersions, "exact_storage_versions");

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
    orgId: sql`${storages.orgId}`,
    userId: sql`${storages.userId}`,
    name: sql`${storages.name}`,
    versionId: sql`CASE WHEN requested.version_id IS NULL OR requested.version_id = ${head.id} THEN ${head.id} ELSE ${exact.id} END`,
    s3Key: sql`CASE WHEN requested.version_id IS NULL OR requested.version_id = ${head.id} THEN ${head.s3Key} ELSE ${exact.s3Key} END`,
  });
}

/** Shared fixed-shape loader for Agent prefetch and thread/request-owned mounts. */
export async function readStorageBaseIndex(
  db: ReadonlyDb,
  requests: readonly StorageRequest[],
): Promise<StorageIndex> {
  const unique = uniqueStorageRequests(requests);
  if (unique.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      orgId: storages.orgId,
      userId: storages.userId,
      name: storages.name,
      storageId: storages.id,
      headVersionId: storages.headVersionId,
      s3Prefix: storages.s3Prefix,
      headId: head.id,
      headS3Key: head.s3Key,
      headArchiveSize: head.archiveSize,
      headFileCount: head.fileCount,
      exactId: exact.id,
      exactS3Key: exact.s3Key,
      exactArchiveSize: exact.archiveSize,
      exactFileCount: exact.fileCount,
      cacheKey: systemStoragePresignedUrlCache.cacheKey,
      cacheScope: systemStoragePresignedUrlCache.scope,
      presignedUrl: systemStoragePresignedUrlCache.presignedUrl,
      expiresAt: systemStoragePresignedUrlCache.expiresAt,
    })
    .from(storages)
    .innerJoin(
      sql`unnest(
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
      and(
        eq(storages.orgId, sql`requested.org_id`),
        eq(storages.userId, sql`requested.user_id`),
        eq(storages.name, sql`requested.name`),
      ),
    )
    .leftJoin(head, eq(storages.headVersionId, head.id))
    .leftJoin(
      exact,
      and(
        eq(
          exact.id,
          sql`NULLIF(requested.version_id, ${storages.headVersionId})`,
        ),
        eq(exact.storageId, storages.id),
      ),
    )
    .leftJoin(
      systemStoragePresignedUrlCache,
      eq(
        systemStoragePresignedUrlCache.cacheKey,
        requestedVersionCacheKeySql(),
      ),
    );
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
      s3Prefix: row.s3Prefix,
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

export function exactStorageVersionsFromIndex(
  mounts: readonly ExecutionStorageRequest[],
  index: StorageIndex,
) {
  return mounts.map((mount) => {
    const storage = index.get(
      storageIndexKey(mount.orgId, mount.userId, mount.name),
    );
    const version =
      storage?.headVersion?.id === mount.versionId
        ? storage.headVersion
        : storage?.exactVersions.get(mount.versionId);
    if (!storage || storage.storageId !== mount.storageId || !version) {
      throw new Error(
        `Requested storage version is unavailable: ${mount.storageId}/${mount.versionId}`,
      );
    }
    if (
      !Number.isSafeInteger(version.archiveSize) ||
      version.archiveSize < 0 ||
      !Number.isSafeInteger(version.fileCount) ||
      version.fileCount < 0 ||
      !version.s3Key
    ) {
      throw new Error("Invalid persisted execution storage version");
    }
    return {
      orgId: mount.orgId,
      userId: mount.userId,
      name: mount.name,
      storageId: mount.storageId,
      versionId: version.id,
      s3Key: version.s3Key,
      archiveSize: version.archiveSize,
      fileCount: version.fileCount,
    };
  });
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
