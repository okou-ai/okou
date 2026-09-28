/**
 * Resolves the built-in image model snapshotted onto a run.
 *
 * The image model follows thread pin, then member default, then catalog
 * default.
 */
import { isImageModelId } from "@okouai/api-contracts/contracts/image-models";
import {
  DEFAULT_IMAGE_MODEL,
  type ImageModel,
} from "@okouai/core/image-model-catalog";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { and, eq } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";

interface RunMediaModels {
  readonly selectedImageModel: ImageModel;
}

/**
 * Stored selections can outlive their catalog entries. Treat those values as
 * unset so data the user can no longer reach does not fail run dispatch.
 */
function catalogedImageModel(
  value: string | null | undefined,
): ImageModel | null {
  return isImageModelId(value) ? value : null;
}

async function threadImageModel(
  db: ReadonlyDb,
  chatThreadId: string,
): Promise<ImageModel | null> {
  const [thread] = await db
    .select({ selectedImageModel: chatThreads.selectedImageModel })
    .from(chatThreads)
    .where(eq(chatThreads.id, chatThreadId))
    .limit(1);
  return catalogedImageModel(thread?.selectedImageModel);
}

async function memberImageModel(
  db: ReadonlyDb,
  orgId: string,
  userId: string,
): Promise<ImageModel | null> {
  const [member] = await db
    .select({ selectedImageModel: orgMembersMetadata.selectedImageModel })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, orgId),
        eq(orgMembersMetadata.userId, userId),
      ),
    )
    .limit(1);
  return catalogedImageModel(member?.selectedImageModel);
}

export async function resolveMediaModelsForRun(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
  /** Threadless triggers skip the thread layer. */
  readonly chatThreadId: string | undefined;
}): Promise<RunMediaModels> {
  const fromThread =
    args.chatThreadId === undefined
      ? null
      : await threadImageModel(args.db, args.chatThreadId);
  if (fromThread !== null) {
    return { selectedImageModel: fromThread };
  }
  return {
    selectedImageModel:
      (await memberImageModel(args.db, args.orgId, args.userId)) ??
      DEFAULT_IMAGE_MODEL,
  };
}
