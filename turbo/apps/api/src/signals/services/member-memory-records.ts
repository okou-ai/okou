import {
  MEMORY_ARTIFACT_NAME,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import {
  memberMemories,
  memoryVersions,
} from "@okouai/db/schema/member-memory";

/** The retained callback protocol names Memory identities as Storage. #47043 P4/P5 owns removal. */
export function memberMemoryStorageRecord(
  row: typeof memberMemories.$inferSelect,
) {
  return {
    id: row.id,
    orgId: row.orgId,
    userId: row.userId,
    name: MEMORY_ARTIFACT_NAME,
    s3Prefix: row.objectPrefix,
    size: row.contentSize,
    fileCount: row.fileCount,
    headVersionId: row.headVersionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
export function memberMemoryVersionRecord(
  row: typeof memoryVersions.$inferSelect,
) {
  return {
    id: row.id,
    storageId: row.memoryId,
    s3Key: row.objectPrefix,
    size: row.contentSize,
    archiveSize: row.archiveSize,
    fileCount: row.fileCount,
    message: row.message,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}
export function isMemberMemoryIdentity(identity: {
  readonly name: string;
  readonly userId: string;
}) {
  return (
    identity.name === MEMORY_ARTIFACT_NAME &&
    identity.userId !== VOLUME_ORG_USER_ID
  );
}
