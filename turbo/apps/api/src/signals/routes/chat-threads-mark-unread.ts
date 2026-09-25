import { command } from "ccstate";
import { and, eq, isNotNull } from "drizzle-orm";
import { chatThreadMarkUnreadContract } from "@okouai/api-contracts/contracts/chat-threads";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agents } from "@okouai/db/schema/agent";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { publishChatThreadReadCursorUpdatedSafely } from "../external/realtime";
import { notFound } from "../../lib/error";
import type { RouteEntry } from "../route-entry";

const markUnreadInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(chatThreadMarkUnreadContract.markUnread));
  signal.throwIfAborted();

  const writeDb = set(writeDb$);

  const [cleared] = await writeDb
    .update(chatThreads)
    .set({ lastReadAt: null })
    .from(agents)
    .where(
      and(
        eq(chatThreads.id, params.id),
        eq(chatThreads.userId, auth.userId),
        eq(agents.id, chatThreads.agentId),
        isNotNull(chatThreads.agentId),
      ),
    )
    .returning({ agentId: agents.id, orgId: agents.orgId });
  signal.throwIfAborted();

  if (!cleared) {
    return notFound("Chat thread not found");
  }

  await publishChatThreadReadCursorUpdatedSafely(
    { userId: auth.userId, orgId: cleared.orgId },
    {
      threadId: params.id,
      agentId: cleared.agentId,
      lastReadAt: null,
    },
  );
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      lastReadAt: null,
      // Rollout fallback for old App -> new API: bundles from before the
      // indicators-only unread state still pass this list to their local
      // read-mark pruning. Remove the field once the client-version floor
      // excludes those bundles (docs/deployment-compatibility.md).
      unreads: [],
    },
  };
});

export const chatThreadMarkUnreadRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadMarkUnreadContract.markUnread,
    handler: authRoute({}, markUnreadInner$),
  },
];
