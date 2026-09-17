import { command } from "ccstate";
import { and, eq, isNotNull } from "drizzle-orm";
import { chatThreadMarkUnreadContract } from "@okouai/api-contracts/contracts/chat-threads";
import { chatThreads } from "@okouai/db/schema/chat-thread";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { publishChatThreadReadCursorUpdatedSafely } from "../external/realtime";
import { notFound } from "../../lib/error";
import { withChatThreadContentWrite } from "../services/chat-thread-content-erasure-admission.service";
import { chatThreadUnreads } from "../services/chat-thread.service";
import type { RouteEntry } from "../route-entry";

/** The canonical parents the publication and unread snapshot need. */
interface MarkUnreadOutcome {
  readonly agentId: string;
  readonly orgId: string;
}

const markUnreadInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(chatThreadMarkUnreadContract.markUnread));
  signal.throwIfAborted();

  const writeDb = set(writeDb$);

  // Clearing a read cursor mutates account read state, so the UPDATE now runs
  // inside the shared B1 admission and the canonical Agent/thread locks. Like
  // mark-read, this route deliberately keeps its user-only authorization: no
  // organization and no capability are required, and an orgless caller or one
  // in a different active organization still owns its own thread. The Agent's
  // actual organization remains an erasure subject because it is the
  // publication target. Clearing stays unconditional, so a repeated request
  // keeps its existing success and publication, and closure reuses the
  // existing 404.
  const result = await withChatThreadContentWrite(
    writeDb,
    {
      chatThreadId: params.id,
      authorize: (identity) => {
        return identity.userId === auth.userId && identity.agentId !== null;
      },
    },
    async (tx, identity): Promise<MarkUnreadOutcome | null> => {
      if (identity.agentId === null || identity.orgId === null) {
        // `authorize` already required a resolved Agent, so this only narrows
        // the canonical publication target; it is not a second contract.
        return null;
      }
      const [thread] = await tx
        .update(chatThreads)
        .set({ lastReadAt: null })
        .where(
          and(
            eq(chatThreads.id, params.id),
            eq(chatThreads.userId, auth.userId),
            isNotNull(chatThreads.agentId),
          ),
        )
        .returning({ id: chatThreads.id });
      if (!thread) {
        return null;
      }
      return { agentId: identity.agentId, orgId: identity.orgId };
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.outcome !== "written" || result.value === null) {
    return notFound("Chat thread not found");
  }
  const cleared = result.value;

  await publishChatThreadReadCursorUpdatedSafely(
    { userId: auth.userId, orgId: cleared.orgId },
    {
      threadId: params.id,
      agentId: cleared.agentId,
      lastReadAt: null,
    },
  );
  signal.throwIfAborted();

  const unreads = await get(
    chatThreadUnreads({
      userId: auth.userId,
      orgId: cleared.orgId,
      agentId: cleared.agentId,
    }),
  );
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      lastReadAt: null,
      unreads: [...unreads],
    },
  };
});

export const chatThreadMarkUnreadRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadMarkUnreadContract.markUnread,
    handler: authRoute({}, markUnreadInner$),
  },
];
