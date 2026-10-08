import { command, computed } from "ccstate";
import { chatThreadMarkReadContract } from "@okouai/api-contracts/contracts/chat-threads";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { publishChatThreadReadCursorUpdatedSafely } from "../external/realtime";
import { notFound } from "../../lib/error";
import {
  advanceChatThreadReadCursor$,
  createChatThreadReadPreparation,
} from "../services/chat-thread-read-state-query";
import type { RouteEntry } from "../route-entry";

const markReadPreparation$ = computed((get) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(chatThreadMarkReadContract.markRead));
  return get(
    createChatThreadReadPreparation({
      threadId: params.id,
      userId: auth.userId,
    }),
  );
});

const markReadInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  signal.throwIfAborted();
  const prepared = await get(markReadPreparation$);
  signal.throwIfAborted();
  if (!prepared) {
    return notFound("Chat thread not found");
  }

  const { threadId, userId, agentId, orgId, watermark } = prepared;
  const advanced =
    watermark !== undefined &&
    (prepared.lastReadAt === null || watermark > prepared.lastReadAt) &&
    (await set(
      advanceChatThreadReadCursor$,
      { threadId, userId, watermark },
      signal,
    ));
  signal.throwIfAborted();
  const lastReadAt =
    (advanced ? watermark : prepared.lastReadAt)?.toISOString() ?? null;

  if (advanced) {
    // Read-state invalidation only. Thread-list shape is unchanged, and the
    // SharedWorker fans the user-org signal out to every matching tab.
    await publishChatThreadReadCursorUpdatedSafely(
      { userId, orgId },
      { threadId, agentId, lastReadAt },
    );
    signal.throwIfAborted();
  }

  return {
    status: 200 as const,
    body: {
      lastReadAt,
    },
  };
});

export const chatThreadMarkReadRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadMarkReadContract.markRead,
    handler: authRoute({}, markReadInner$),
  },
];
