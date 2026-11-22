import { randomUUID } from "node:crypto";

/**
 * Allocate an object prefix for a new member Memory. Its ID is immutable
 * across org renames and independent of other members in the same org.
 * Existing memories retain historical layouts in member_memories.object_prefix.
 */
export function newStorageS3Location(orgId: string): {
  readonly storageId: string;
  readonly s3Prefix: string;
} {
  const storageId = randomUUID();
  return { storageId, s3Prefix: `${orgId}/${storageId}` };
}
