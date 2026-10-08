import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { db } from "../lib/db";

/**
 * Persisted pre-retirement settings cannot be constructed through today's
 * model preference API. Verify their normalization through production reads
 * and image generation, never by asserting on the stored row.
 */
export async function seedRetiredMemberImageModelFixture(
  orgId: string,
  userId: string,
): Promise<void> {
  const selectedImageModel = "retired-image-model";
  await db()
    .insert(orgMembersMetadata)
    .values({ orgId, userId, selectedImageModel })
    .onConflictDoUpdate({
      target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
      set: { selectedImageModel },
    });
}
