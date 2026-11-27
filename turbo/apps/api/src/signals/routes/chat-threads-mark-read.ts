import { synchronizeUserPushBadge$ } from "../services/push-notifications.service";
import { waitUntil } from "../context/wait-until";
import { command, computed } from "ccstate";
import { chatThreadMarkReadContract } from "@okouai/api-contracts/contracts/chat-threads";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { publishChatThreadReadCursorUpdatedSafely } from "../external/realtime";
import { notFound } from "../../lib/error";
import {
  advanceChatThreadReadCursors$,
  createChatThreadReadPreparation,
} from "../services/chat-thread-read-state-query";
import type { RouteEntry } from "../route-entry";

const markReadPreparation$ = computed((get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(chatThreadMarkReadContract.markRead));
  return get(
    createChatThreadReadPreparation({
      threadId: params.id,
      userId: auth.userId,
      orgId: auth.orgId,
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

  const { threadId, userId, orgId, watermark } = prepared;
  const advanced =
    watermark !== undefined &&
    (prepared.lastReadAt === null || watermark > prepared.lastReadAt) &&
    (
      await set(
        advanceChatThreadReadCursors$,
        { userId, orgId, cursors: [{ threadId, watermark }] },
        signal,
      )
    ).length > 0;
  signal.throwIfAborted();
  const lastReadAt =
    (advanced ? watermark : prepared.lastReadAt)?.toISOString() ?? null;

  if (advanced) {
    // Read-state invalidation only. Thread-list shape is unchanged, and every
    // matching tab receives the user-org signal directly.
    waitUntil(
      set(synchronizeUserPushBadge$, userId, new AbortController().signal),
    );
    await publishChatThreadReadCursorUpdatedSafely(
      { userId, orgId },
      { threadId, lastReadAt },
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
    handler: authRoute(
      { requireOrganization: true, oauthScope: "okou:chat:read" },
      markReadInner$,
    ),
  },
];
