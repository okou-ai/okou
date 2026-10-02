import { and, eq, inArray, or } from "drizzle-orm";
import { systemStoragePresignedUrlCache } from "@okouai/db/schema/system-storage-presigned-url-cache";
import type { ReadonlyDb } from "../external/db";
import type {
  StorageManifestPresignedUrlCacheScope,
  SelectedStoragePresignedUrlCacheRow,
} from "./system-storage-presigned-url-cache.service";

export type ExecutionStorageCacheRows =
  readonly (SelectedStoragePresignedUrlCacheRow & {
    readonly scope: StorageManifestPresignedUrlCacheScope;
  })[];

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
