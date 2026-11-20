import {
  memberMemories,
  memoryVersions,
} from "@okouai/db/schema/member-memory";
import { systemStoragePresignedUrlCache } from "@okouai/db/runtime/system-storage-presigned-url-cache";
import { computed } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { env } from "../../lib/env";
import { db$ } from "../external/db";
import type { MemberMemoryOwner } from "./member-memory";
import {
  readOnlyStoragePresignedUrlCacheKeySql,
  type SelectedStoragePresignedUrlCacheRow,
} from "./system-storage-presigned-url-cache.service";

export interface MemberMemoryHead {
  readonly storageId: string;
  readonly versionId: string;
  readonly s3Key: string;
  readonly archiveSize: number;
  readonly fileCount: number;
  readonly archiveCache: SelectedStoragePresignedUrlCacheRow | null;
}

/** Capture HEAD, its owned revision and the matching archive URL together. */
export function createMemberMemoryHead(owner: MemberMemoryOwner) {
  return computed(async (get): Promise<MemberMemoryHead | null> => {
    const [memory] = await get(db$)
      .select({
        storageId: memberMemories.id,
        headVersionId: memberMemories.headVersionId,
        revision: {
          versionId: memoryVersions.id,
          s3Key: memoryVersions.objectPrefix,
          archiveSize: memoryVersions.archiveSize,
          fileCount: memoryVersions.fileCount,
        },
        archiveCache: {
          cacheKey: systemStoragePresignedUrlCache.cacheKey,
          presignedUrl: systemStoragePresignedUrlCache.presignedUrl,
          expiresAt: systemStoragePresignedUrlCache.expiresAt,
        },
      })
      .from(memberMemories)
      .leftJoin(
        memoryVersions,
        and(
          eq(memoryVersions.memoryId, memberMemories.id),
          eq(memoryVersions.id, memberMemories.headVersionId),
        ),
      )
      .leftJoin(
        systemStoragePresignedUrlCache,
        and(
          eq(systemStoragePresignedUrlCache.scope, "readonly_storage"),
          eq(
            systemStoragePresignedUrlCache.cacheKey,
            readOnlyStoragePresignedUrlCacheKeySql({
              bucket: env("R2_USER_STORAGES_BUCKET_NAME"),
              objectKey: sql`${memoryVersions.objectPrefix} || '/archive.tar.gz'`,
              storageVersionId: sql`${memoryVersions.id}`,
              resolvedOrgId: sql`${memberMemories.orgId}`,
            }),
          ),
        ),
      )
      .where(
        and(
          eq(memberMemories.orgId, owner.orgId),
          eq(memberMemories.userId, owner.userId),
        ),
      );
    if (!memory || memory.headVersionId === null) {
      return null;
    }
    if (!memory.revision) {
      throw new Error("Member Memory HEAD revision is missing");
    }
    return {
      storageId: memory.storageId,
      ...memory.revision,
      archiveCache: memory.archiveCache,
    };
  });
}
