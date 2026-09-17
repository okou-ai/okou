import { command } from "ccstate";
import { and, eq, gt, isNotNull, isNull, or } from "drizzle-orm";
import { chatThreadMarkReadContract } from "@okouai/api-contracts/contracts/chat-threads";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { agents } from "@okouai/db/schema/agent";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { publishChatThreadReadCursorUpdatedSafely } from "../external/realtime";
import { notFound } from "../../lib/error";
import { latestReadWatermarkEventSubquery } from "../services/chat-thread-read-state-query";
import { chatThreadUnreads } from "../services/chat-thread.service";
import type { RouteEntry } from "../route-entry";

const markReadInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(chatThreadMarkReadContract.markRead));
  signal.throwIfAborted();

  const writeDb = set(writeDb$);

  const [thread] = await writeDb
    .select({
      lastReadAt: chatThreads.lastReadAt,
      agentId: agents.id,
      orgId: agents.orgId,
    })
    .from(chatThreads)
    .innerJoin(agents, eq(agents.id, chatThreads.agentId))
    .where(
      and(eq(chatThreads.id, params.id), eq(chatThreads.userId, auth.userId)),
    )
    .limit(1);
  signal.throwIfAborted();

  if (!thread) {
    return notFound("Chat thread not found");
  }
  const agentId = thread.agentId;

  const agentUnreads = async () => {
    const unreads = await get(
      chatThreadUnreads({
        userId: auth.userId,
        orgId: thread.orgId,
        agentId: agentId,
      }),
    );
    return [...unreads];
  };

  const lastReadAt = thread.lastReadAt?.toISOString() ?? null;
  const latestReadWatermark = latestReadWatermarkEventSubquery(
    writeDb,
    params.id,
  );
  const [updated] = await writeDb
    .update(chatThreads)
    .set({ lastReadAt: latestReadWatermark.createdAt })
    .from(latestReadWatermark)
    .where(
      and(
        eq(chatThreads.id, params.id),
        eq(chatThreads.userId, auth.userId),
        isNotNull(chatThreads.agentId),
        or(
          isNull(chatThreads.lastReadAt),
          gt(latestReadWatermark.createdAt, chatThreads.lastReadAt),
        ),
      ),
    )
    .returning({ lastReadAt: chatThreads.lastReadAt });
  signal.throwIfAborted();

  if (!updated) {
    return {
      status: 200 as const,
      body: {
        lastReadAt,
        unreads: await agentUnreads(),
      },
    };
  }

  // Read-state invalidation only. Thread-list shape is unchanged, and the
  // SharedWorker fans the user-org signal out to every matching tab.
  await publishChatThreadReadCursorUpdatedSafely(
    { userId: auth.userId, orgId: thread.orgId },
    {
      threadId: params.id,
      agentId,
      lastReadAt: updated.lastReadAt?.toISOString() ?? null,
    },
  );
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      lastReadAt: updated.lastReadAt?.toISOString() ?? null,
      unreads: await agentUnreads(),
    },
  };
});

export const chatThreadMarkReadRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadMarkReadContract.markRead,
    handler: authRoute({}, markReadInner$),
  },
];
