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

  // One single-row UPDATE outside any transaction, then a primary-key read of
  // the Agent's organization for the publication. Like mark-read, the route
  // keeps its user-only authorization, and clearing stays unconditional so a
  // repeated request keeps its success and publication.
  const [cleared] = await writeDb
    .update(chatThreads)
    .set({ lastReadAt: null })
    .where(
      and(
        eq(chatThreads.id, params.id),
        eq(chatThreads.userId, auth.userId),
        isNotNull(chatThreads.agentId),
      ),
    )
    .returning({ agentId: chatThreads.agentId });
  signal.throwIfAborted();
  if (!cleared?.agentId) {
    return notFound("Chat thread not found");
  }
  const [agent] = await writeDb
    .select({ orgId: agents.orgId })
    .from(agents)
    .where(eq(agents.id, cleared.agentId))
    .limit(1);
  signal.throwIfAborted();
  if (!agent) {
    return notFound("Chat thread not found");
  }

  await publishChatThreadReadCursorUpdatedSafely(
    { userId: auth.userId, orgId: agent.orgId },
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
    },
  };
});

export const chatThreadMarkUnreadRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadMarkUnreadContract.markUnread,
    handler: authRoute({}, markUnreadInner$),
  },
];
