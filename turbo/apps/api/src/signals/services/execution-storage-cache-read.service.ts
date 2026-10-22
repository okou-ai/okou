import {
  SYSTEM_ORG_ID,
  VOLUME_ORG_USER_ID,
  getCustomSkillStorageName,
} from "@okouai/core/storage-names";
import { sql, type SQL } from "drizzle-orm";
import { env } from "../../lib/env";
import {
  storagePresignedUrlCacheKeySql,
  type SelectedStoragePresignedUrlCacheRow,
  type StorageManifestPresignedUrlCacheScope,
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
