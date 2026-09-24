/**
 * Resolves the built-in media models snapshotted onto a run.
 *
 * Video and image independently follow thread pin, then member default, then
 * catalog default. Read both fields together at each layer so one run does not
 * issue duplicate queries for the same thread or member row.
 */
import { isImageModelId } from "@okouai/api-contracts/contracts/image-models";
import { isVideoModelId } from "@okouai/api-contracts/contracts/video-models";
import {
  DEFAULT_IMAGE_MODEL,
  type ImageModel,
} from "@okouai/core/image-model-catalog";
import {
  DEFAULT_VIDEO_MODEL,
  type VideoModel,
} from "@okouai/core/video-model-catalog";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { and, eq } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";

interface OptionalRunMediaModels {
  readonly selectedVideoModel: VideoModel | null;
  readonly selectedImageModel: ImageModel | null;
}

interface RunMediaModels {
  readonly selectedVideoModel: VideoModel;
  readonly selectedImageModel: ImageModel;
}

/**
 * Stored selections can outlive their catalog entries. Treat those values as
 * unset so data the user can no longer reach does not fail run dispatch.
 */
function catalogedVideoModel(
  value: string | null | undefined,
): VideoModel | null {
  return isVideoModelId(value) ? value : null;
}

function catalogedImageModel(
  value: string | null | undefined,
): ImageModel | null {
  return isImageModelId(value) ? value : null;
}

async function threadMediaModels(
  db: ReadonlyDb,
  chatThreadId: string,
): Promise<OptionalRunMediaModels> {
  const [thread] = await db
    .select({
      selectedVideoModel: chatThreads.selectedVideoModel,
      selectedImageModel: chatThreads.selectedImageModel,
    })
    .from(chatThreads)
    .where(eq(chatThreads.id, chatThreadId))
    .limit(1);
  return {
    selectedVideoModel: catalogedVideoModel(thread?.selectedVideoModel),
    selectedImageModel: catalogedImageModel(thread?.selectedImageModel),
  };
}

async function memberMediaModels(
  db: ReadonlyDb,
  orgId: string,
  userId: string,
): Promise<OptionalRunMediaModels> {
  const [member] = await db
    .select({
      selectedVideoModel: orgMembersMetadata.selectedVideoModel,
      selectedImageModel: orgMembersMetadata.selectedImageModel,
    })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, orgId),
        eq(orgMembersMetadata.userId, userId),
      ),
    )
    .limit(1);
  return {
    selectedVideoModel: catalogedVideoModel(member?.selectedVideoModel),
    selectedImageModel: catalogedImageModel(member?.selectedImageModel),
  };
}

export async function resolveMediaModelsForRun(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
  /** Threadless triggers skip the thread layer. */
  readonly chatThreadId: string | undefined;
}): Promise<RunMediaModels> {
  const threadModels: OptionalRunMediaModels =
    args.chatThreadId === undefined
      ? { selectedVideoModel: null, selectedImageModel: null }
      : await threadMediaModels(args.db, args.chatThreadId);
  if (
    threadModels.selectedVideoModel !== null &&
    threadModels.selectedImageModel !== null
  ) {
    return {
      selectedVideoModel: threadModels.selectedVideoModel,
      selectedImageModel: threadModels.selectedImageModel,
    };
  }

  const memberModels = await memberMediaModels(
    args.db,
    args.orgId,
    args.userId,
  );
  return {
    selectedVideoModel:
      threadModels.selectedVideoModel ??
      memberModels.selectedVideoModel ??
      DEFAULT_VIDEO_MODEL,
    selectedImageModel:
      threadModels.selectedImageModel ??
      memberModels.selectedImageModel ??
      DEFAULT_IMAGE_MODEL,
  };
}
