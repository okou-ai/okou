import { command, computed } from "ccstate";
import { chatThreadMarkAgentReadContract } from "@okouai/api-contracts/contracts/chat-threads";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { publishChatThreadReadCursorUpdatedSafely } from "../external/realtime";
import {
  advanceChatThreadReadCursor$,
  createAgentThreadReadPreparation,
} from "../services/chat-thread-read-state-query";
import type { RouteEntry } from "../route-entry";

const markAgentReadBody$ = bodyResultOf(
  chatThreadMarkAgentReadContract.markAgentRead,
);
const markAgentReadPreparation$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(markAgentReadBody$);
  if (!bodyResult.ok) {
    return bodyResult;
  }
  const { agentId } = bodyResult.data;
  const cursors = await get(
    createAgentThreadReadPreparation({
      agentId,
      userId: auth.userId,
      orgId: auth.orgId,
    }),
  );
  return {
    ok: true as const,
    agentId,
    userId: auth.userId,
    orgId: auth.orgId,
    cursors,
  };
});

/**
 * How many exact thread ids one notification carries. At the budget, UUID ids
 * plus the Agent id keep the serialized payload near four kibibytes; a larger
 * update publishes an Agent-scoped invalidation instead.
 */
const NOTIFIED_THREAD_ID_BUDGET = 100;

/** Marks only prepared caller-owned cursors; publication follows committed CAS writes. */
const markAgentReadInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const prepared = await get(markAgentReadPreparation$);
    signal.throwIfAborted();
    if (!prepared.ok) {
      return prepared.response;
    }
    const { agentId, userId, orgId, cursors } = prepared;
    if (!cursors) {
      return { status: 204 as const, body: undefined };
    }

    const updatedThreadIds: string[] = [];
    for (const cursor of cursors) {
      const advanced = await set(
        advanceChatThreadReadCursor$,
        { ...cursor, userId },
        signal,
      );
      signal.throwIfAborted();
      if (advanced) {
        updatedThreadIds.push(cursor.threadId);
      }
    }

    if (updatedThreadIds.length > 0) {
      await publishChatThreadReadCursorUpdatedSafely(
        { userId, orgId },
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
