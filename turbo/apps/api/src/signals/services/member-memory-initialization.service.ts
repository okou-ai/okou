import { computeContentHashFromHashes } from "@okouai/api-contracts/contracts/storage-content-hash";
import {
  memberMemories,
  memoryVersions,
} from "@okouai/db/schema/member-memory";
import { command } from "ccstate";
import { isNull, sql } from "drizzle-orm";
import { int, object, string, uuid } from "zod";

import { parseRawRows, pgInt8ToSafeIntegerSchema } from "../../lib/db-raw-rows";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import type { MemberMemoryOwner } from "./member-memory";
import type { MemberMemoryHead } from "./member-memory-head.service";
import { newStorageS3Location } from "./storage-s3-prefix.utils";

const initializedMemorySchema = object({
  storageId: uuid(),
  versionId: string(),
  s3Key: string(),
  archiveSize: pgInt8ToSafeIntegerSchema,
  fileCount: int(),
});

/** Establish the member's Memory and empty revision in one statement. */
export const initializeMemberMemory$ = command(
  async (
    { set },
    identity: MemberMemoryOwner,
    signal: AbortSignal,
  ): Promise<MemberMemoryHead | null> => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    const location = newStorageS3Location(identity.orgId);
    const candidateVersionId = computeContentHashFromHashes(
      location.storageId,
      [],
    );
    const updatedAt = nowDate();
    // The conflict branch uses the incumbent UUID and prefix. A published HEAD
    // accepts no row, so replayed initialization cannot replace its content.
    const initialized = db
      .insert(memberMemories)
      .values({
        id: location.storageId,
        orgId: identity.orgId,
        userId: identity.userId,
        objectPrefix: location.s3Prefix,
        headVersionId: candidateVersionId,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [memberMemories.orgId, memberMemories.userId],
        set: {
          headVersionId: sql`encode(sha256(convert_to('storage:' || ${memberMemories.id}::text || chr(10), 'UTF8')), 'hex')`,
          contentSize: 0,
          fileCount: 0,
          updatedAt,
        },
        setWhere: isNull(memberMemories.headVersionId),
      })
      .returning()
      .getSQL();
    const statement = sql`WITH initialized AS (${initialized})
      INSERT INTO ${memoryVersions}
        (id,memory_id,object_prefix,content_size,archive_size,file_count,message,created_by)
      SELECT initialized.head_version_id,initialized.id,
        initialized.object_prefix || '/' || initialized.head_version_id,0,0,0,
        ${sql.param("Initial empty artifact", memoryVersions.message)},
        ${sql.param(identity.userId, memoryVersions.createdBy)} FROM initialized
      ON CONFLICT (id) DO UPDATE SET id=excluded.id
      RETURNING memory_id AS "storageId", id AS "versionId",
        object_prefix AS "s3Key", archive_size AS "archiveSize",
        file_count AS "fileCount"`;
    signal.throwIfAborted();
    const [head] = parseRawRows(
      initializedMemorySchema,
      await db.execute(statement),
    );
    signal.throwIfAborted();
    return head ? { ...head, archiveCache: null } : null;
  },
);
