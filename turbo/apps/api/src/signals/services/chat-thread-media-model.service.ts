/**
 * Resolves the image model a chat thread is pinned to when it is created.
 *
 * A thread stamps its image model the same way it stamps its run model: once,
 * at creation. An unpinned thread re-reads the member default on every run, so
 * changing that default later would retarget threads the user had already
 * started. Threads created before this pin existed still hold null and keep
 * falling through the member default in run-media-model.service.
 */
import { isImageModelId } from "@okouai/api-contracts/contracts/image-models";
import {
  DEFAULT_IMAGE_MODEL,
  type ImageModel,
} from "@okouai/core/image-model-catalog";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { and, eq } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";

export interface NewChatThreadMediaModels {
  readonly selectedImageModel: ImageModel | null;
}

/** Member default, then catalog default. */
export async function loadNewChatThreadMediaModels(
  db: Pick<ReadonlyDb, "select">,
  args: { readonly orgId: string; readonly userId: string },
): Promise<NewChatThreadMediaModels> {
  const [member] = await db
    .select({ selectedImageModel: orgMembersMetadata.selectedImageModel })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, args.orgId),
        eq(orgMembersMetadata.userId, args.userId),
      ),
    )
    .limit(1);
  // A stored id that has left its catalog counts as unset, matching how
  // dispatch narrows an existing pin.
  const stored = member?.selectedImageModel ?? null;
  return {
    selectedImageModel: isImageModelId(stored) ? stored : DEFAULT_IMAGE_MODEL,
  };
}
