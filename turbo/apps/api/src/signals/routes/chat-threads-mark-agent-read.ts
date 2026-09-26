import { command } from "ccstate";
import { and, desc, eq, gt, gte, isNull, or } from "drizzle-orm";
import { chatThreadMarkAgentReadContract } from "@okouai/api-contracts/contracts/chat-threads";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agents } from "@okouai/db/schema/agent";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { publishChatThreadReadCursorUpdatedSafely } from "../external/realtime";
import { nowDate } from "../../lib/time";
import {
  INDICATOR_UNREAD_CANDIDATE_LIMIT,
  INDICATOR_UNREAD_LOOKBACK_MS,
} from "../services/chat-thread.service";
import {
  advanceChatThreadReadCursor,
  loadLatestReadWatermarks,
} from "../services/chat-thread-read-state-query";
import type { RouteEntry } from "../route-entry";

const markAgentReadBody$ = bodyResultOf(
  chatThreadMarkAgentReadContract.markAgentRead,
);

/**
 * How many exact thread ids one notification carries. At the budget, UUID ids
 * plus the Agent id keep the serialized payload near four kibibytes; a larger
 * update publishes an Agent-scoped invalidation instead.
 */
const NOTIFIED_THREAD_ID_BUDGET = 100;

/**
 * Marks the caller's unread threads under one Agent as read.
 *
 * The same bounded candidate set the unread indicators use: threads with a
 * message in the last seven days that is newer than their read cursor, newest
 * first, at most {@link INDICATOR_UNREAD_CANDIDATE_LIMIT}. Older threads are
 * not shown as unread by the indicators and are left untouched. Each thread
 * advances with its own single-row compare-and-set outside any transaction, so
 * no statement holds more than one thread row.
 */
const markAgentReadInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(markAgentReadBody$);
    signal.throwIfAborted();

    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const { agentId } = bodyResult.data;
    const writeDb = set(writeDb$);
    const [agent] = await writeDb
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.orgId, auth.orgId)))
      .limit(1);
    signal.throwIfAborted();
    if (!agent) {
      return { status: 204 as const, body: undefined };
    }

    const candidates = await writeDb
      .select({ id: chatThreads.id, lastReadAt: chatThreads.lastReadAt })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.userId, auth.userId),
          eq(chatThreads.agentId, agentId),
          gte(
            chatThreads.lastMessageAt,
            new Date(nowDate().getTime() - INDICATOR_UNREAD_LOOKBACK_MS),
          ),
          or(
            isNull(chatThreads.lastReadAt),
            gt(chatThreads.lastMessageAt, chatThreads.lastReadAt),
          ),
        ),
      )
      .orderBy(desc(chatThreads.lastMessageAt), desc(chatThreads.id))
      .limit(INDICATOR_UNREAD_CANDIDATE_LIMIT);
    signal.throwIfAborted();

    const watermarks = await loadLatestReadWatermarks(
      writeDb,
      candidates.map((candidate) => {
        return candidate.id;
      }),
    );
    signal.throwIfAborted();

    const updatedThreadIds: string[] = [];
    for (const candidate of candidates) {
      const watermark = watermarks.get(candidate.id);
      if (
        watermark === undefined ||
        (candidate.lastReadAt !== null && watermark <= candidate.lastReadAt)
      ) {
        continue;
      }
      const advanced = await advanceChatThreadReadCursor(writeDb, {
        threadId: candidate.id,
        userId: auth.userId,
        watermark,
      });
      signal.throwIfAborted();
      if (advanced) {
        updatedThreadIds.push(candidate.id);
      }
    }

    if (updatedThreadIds.length > 0) {
      await publishChatThreadReadCursorUpdatedSafely(
        { userId: auth.userId, orgId: auth.orgId },
        updatedThreadIds.length > NOTIFIED_THREAD_ID_BUDGET
          ? { agentId, threadIds: [], scope: "agent" }
          : { agentId, threadIds: updatedThreadIds },
      );
      signal.throwIfAborted();
    }

    return { status: 204 as const, body: undefined };
  },
);

export const chatThreadMarkAgentReadRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadMarkAgentReadContract.markAgentRead,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      markAgentReadInner$,
    ),
  },
];
