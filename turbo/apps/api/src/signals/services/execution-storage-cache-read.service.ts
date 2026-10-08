import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import {
  SYSTEM_ORG_ID,
  VOLUME_ORG_USER_ID,
  getCustomSkillStorageName,
} from "@okouai/core/storage-names";
import { env } from "../../lib/env";
import { systemStoragePresignedUrlCache } from "@okouai/db/schema/system-storage-presigned-url-cache";
import type { ReadonlyDb } from "../external/db";
import {
  storagePresignedUrlCacheKeySql,
  type StorageManifestPresignedUrlCacheScope,
  type SelectedStoragePresignedUrlCacheRow,
} from "./system-storage-presigned-url-cache.service";

export type ExecutionStorageCacheRows =
  readonly (SelectedStoragePresignedUrlCacheRow & {
    readonly scope: StorageManifestPresignedUrlCacheScope;
  })[];

export function storageVersionCacheKeySql(input: {
  readonly orgId: SQL;
  readonly userId: SQL;
  readonly name: SQL;
  readonly versionId: SQL;
  readonly s3Key: SQL;
}): SQL {
  const request = {
    bucket: env("R2_USER_STORAGES_BUCKET_NAME"),
    objectKey: sql`${input.s3Key} || '/archive.tar.gz'`,
    storageVersionId: input.versionId,
    resolvedOrgId: input.orgId,
  };
  return sql`CASE WHEN ${input.orgId} = ${SYSTEM_ORG_ID} THEN ${storagePresignedUrlCacheKeySql("system_storage", request)} WHEN ${input.userId} = ${VOLUME_ORG_USER_ID} AND ${input.name} LIKE ${getCustomSkillStorageName("") + "%"} THEN ${storagePresignedUrlCacheKeySql("workflow_skill_storage", request)} ELSE ${storagePresignedUrlCacheKeySql("readonly_storage", request)} END`;
}

export function cacheRowsFromProjection(row: {
  readonly cacheKey: string | null;
  readonly cacheScope: string | null;
  readonly presignedUrl: string | null;
  readonly expiresAt: Date | null;
}): ExecutionStorageCacheRows {
  if (row.cacheKey === null) {
    return [];
  }
  if (
    (row.cacheScope !== "system_storage" &&
      row.cacheScope !== "workflow_skill_storage" &&
      row.cacheScope !== "readonly_storage") ||
    row.presignedUrl === null ||
    row.expiresAt === null
  ) {
    throw new Error("Invalid joined execution storage cache row");
  }
  return [
    {
      cacheKey: row.cacheKey,
      scope: row.cacheScope,
      presignedUrl: row.presignedUrl,
      expiresAt: row.expiresAt,
    },
  ];
}

/** One cache query per read owner; absent and failed snapshots are not reread. */
export async function readExecutionStorageCacheRows(
  db: ReadonlyDb,
  pairs: readonly {
    readonly scope: StorageManifestPresignedUrlCacheScope;
    readonly cacheKey: string;
  }[],
): Promise<ExecutionStorageCacheRows> {
  const scopes: readonly StorageManifestPresignedUrlCacheScope[] = [
    "system_storage",
    "workflow_skill_storage",
    "readonly_storage",
  ];
  const conditions = scopes.flatMap((scope) => {
    const keys = [
      ...new Set(
        pairs
          .filter((pair) => {
            return pair.scope === scope;
          })
          .map((pair) => {
            return pair.cacheKey;
          }),
      ),
    ];
    return keys.length === 0
      ? []
      : [
          and(
            eq(systemStoragePresignedUrlCache.scope, scope),
            inArray(systemStoragePresignedUrlCache.cacheKey, keys),
          ),
        ];
  });
  const rows =
    conditions.length === 0
      ? []
      : await db
          .select({
            scope: systemStoragePresignedUrlCache.scope,
            cacheKey: systemStoragePresignedUrlCache.cacheKey,
            presignedUrl: systemStoragePresignedUrlCache.presignedUrl,
            expiresAt: systemStoragePresignedUrlCache.expiresAt,
          })
          .from(systemStoragePresignedUrlCache)
          .where(or(...conditions));
  return rows.map((row) => {
    if (
      row.scope !== "system_storage" &&
      row.scope !== "workflow_skill_storage" &&
      row.scope !== "readonly_storage"
    ) {
      throw new Error("Unexpected execution storage cache scope");
    }
    return { ...row, scope: row.scope };
  });
}
