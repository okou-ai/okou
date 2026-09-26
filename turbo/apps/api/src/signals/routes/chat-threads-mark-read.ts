import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { chatThreadMarkReadContract } from "@okouai/api-contracts/contracts/chat-threads";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agents } from "@okouai/db/schema/agent";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { publishChatThreadReadCursorUpdatedSafely } from "../external/realtime";
import { notFound } from "../../lib/error";
import {
  advanceChatThreadReadCursor,
  loadLatestReadWatermarks,
} from "../services/chat-thread-read-state-query";
import type { RouteEntry } from "../route-entry";

const markReadInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(chatThreadMarkReadContract.markRead));
  signal.throwIfAborted();

  const writeDb = set(writeDb$);

  // Bounded primary-key reads outside any transaction, then one single-row
  // compare-and-set. The route keeps its user-only authorization: it needs no
  // organization, and publishes to the Agent's own organization.
  const [thread] = await writeDb
    .select({
      agentId: chatThreads.agentId,
      lastReadAt: chatThreads.lastReadAt,
    })
    .from(chatThreads)
    .where(
      and(eq(chatThreads.id, params.id), eq(chatThreads.userId, auth.userId)),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!thread?.agentId) {
    return notFound("Chat thread not found");
  }
  const agentId = thread.agentId;
  const [agent] = await writeDb
    .select({ orgId: agents.orgId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  signal.throwIfAborted();
  if (!agent) {
    return notFound("Chat thread not found");
  }

  const watermark = (await loadLatestReadWatermarks(writeDb, [params.id])).get(
    params.id,
  );
  signal.throwIfAborted();
  const advanced =
    watermark !== undefined &&
    (thread.lastReadAt === null || watermark > thread.lastReadAt) &&
    (await advanceChatThreadReadCursor(writeDb, {
      threadId: params.id,
      userId: auth.userId,
      watermark,
    }));
  signal.throwIfAborted();
  const lastReadAt =
    (advanced ? watermark : thread.lastReadAt)?.toISOString() ?? null;

  if (advanced) {
    // Read-state invalidation only. Thread-list shape is unchanged, and the
    // SharedWorker fans the user-org signal out to every matching tab.
    await publishChatThreadReadCursorUpdatedSafely(
      { userId: auth.userId, orgId: agent.orgId },
      { threadId: params.id, agentId, lastReadAt },
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
