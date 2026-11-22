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

export const memberMemoryHeadFields = Object.freeze({
  memory: {
    storageId: memberMemories.id,
    headVersionId: memberMemories.headVersionId,
  },
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
});

export function memberMemoryOwnerCondition(owner: MemberMemoryOwner) {
  return and(
    eq(memberMemories.orgId, owner.orgId),
    eq(memberMemories.userId, owner.userId),
  );
}

export const memberMemoryRevisionCondition = and(
  eq(memoryVersions.memoryId, memberMemories.id),
  eq(memoryVersions.id, memberMemories.headVersionId),
);

export function memberMemoryArchiveCondition() {
  return and(
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
  );
}

export function decodeMemberMemoryHead(
  row:
    | {
        readonly memory: {
          readonly storageId: string;
          readonly headVersionId: string | null;
        } | null;
        readonly revision: Omit<
          MemberMemoryHead,
          "storageId" | "archiveCache"
        > | null;
        readonly archiveCache: MemberMemoryHead["archiveCache"];
      }
    | undefined,
): MemberMemoryHead | null {
  if (!row?.memory || row.memory.headVersionId === null) {
    return null;
  }
  if (!row.revision) {
    throw new Error("Member Memory HEAD revision is missing");
  }
  return {
    storageId: row.memory.storageId,
    ...row.revision,
    archiveCache: row.archiveCache,
  };
}

/** Resolve the exact winner when another initializer created the Memory root. */
export function createMemberMemoryHead(owner: MemberMemoryOwner) {
  return computed(async (get) => {
    const [row] = await get(db$)
      .select(memberMemoryHeadFields)
      .from(memberMemories)
      .leftJoin(memoryVersions, memberMemoryRevisionCondition)
      .leftJoin(systemStoragePresignedUrlCache, memberMemoryArchiveCondition())
      .where(memberMemoryOwnerCondition(owner));
    return decodeMemberMemoryHead(row);
  });
}
