/**
 * Resolves the built-in image model snapshotted onto a run.
 *
 * The image model is a member setting: member default, then catalog default.
 */
import { isImageModelId } from "@okouai/api-contracts/contracts/image-models";
import {
  DEFAULT_IMAGE_MODEL,
  type ImageModel,
} from "@okouai/core/image-model-catalog";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { and, eq } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";

export async function resolveImageModelForRun(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
}): Promise<ImageModel> {
  const [member] = await args.db
    .select({ selectedImageModel: orgMembersMetadata.selectedImageModel })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, args.orgId),
        eq(orgMembersMetadata.userId, args.userId),
      ),
    )
    .limit(1);
  // Stored selections can outlive their catalog entries. Treat those values
  // as unset so data the user can no longer reach does not fail run dispatch.
  const stored = member?.selectedImageModel;
  return isImageModelId(stored) ? stored : DEFAULT_IMAGE_MODEL;
}
