import { command } from "ccstate";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { chatThreadMarkAgentReadContract } from "@okouai/api-contracts/contracts/chat-threads";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agents } from "@okouai/db/schema/agent";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import { publishChatThreadReadCursorUpdatedSafely } from "../external/realtime";
import { executeRawRows } from "../../lib/db-raw-rows";
import { latestReadWatermarkEventSubquery } from "../services/chat-thread-read-state-query";
import type { RouteEntry } from "../route-entry";

const markAgentReadBody$ = bodyResultOf(
  chatThreadMarkAgentReadContract.markAgentRead,
);

/**
 * How many exact thread ids one notification carries. This is an explicit
 * transport budget for the ids that cross the driver and the published payload,
 * not a provider limit: at the budget, UUID ids plus the Agent id keep the
 * serialized payload near four kibibytes.
 *
 * It never bounds the UPDATE. The statement below reads one id past the budget
 * purely to detect overflow.
 */
const NOTIFIED_THREAD_ID_BUDGET = 100;

const updatedThreadRowSchema = z.object({ id: z.string().uuid() });

/**
 * Moves every unread cursor under one Agent for one user, in one statement.
 *
 * The complete all-matching UPDATE runs inside a data-modifying CTE, so
 * PostgreSQL executes it exactly once and to completion however few rows the
 * outer query reads. The outer `LIMIT` therefore bounds only the ids returned
 * to this process; it never turns into a partial page, a batch or a partial
 * commit, and the work remains O(every matching row).
 *
 * The inner statement keeps this route's existing selection and monotonic
 * recheck unchanged, including the latest-terminal-event ordering that owns the
 * cursor value.
 */
async function markAgentThreadsRead(
  db: Db,
  args: {
    readonly agentId: string;
    readonly userId: string;
    readonly orgId: string;
  },
): Promise<readonly string[]> {
  const latestReadWatermark = latestReadWatermarkEventSubquery(
    db,
    chatThreads.id,
  );
  const unreadThreads = db
    .select({
      threadId: chatThreads.id,
      latestReadWatermarkAt: latestReadWatermark.createdAt,
    })
    .from(chatThreads)
    .innerJoin(agents, eq(agents.id, chatThreads.agentId))
    .crossJoinLateral(latestReadWatermark)
    .where(
      and(
        eq(chatThreads.userId, args.userId),
        eq(agents.orgId, args.orgId),
        eq(chatThreads.agentId, args.agentId),
        or(
          isNull(chatThreads.lastReadAt),
          gt(latestReadWatermark.createdAt, chatThreads.lastReadAt),
        ),
      ),
    )
    .as("unread_threads");
  const updateEveryMatchingThread = db
    .update(chatThreads)
    .set({ lastReadAt: unreadThreads.latestReadWatermarkAt })
    .from(unreadThreads)
    .where(
      and(
        eq(chatThreads.id, unreadThreads.threadId),
        eq(chatThreads.userId, args.userId),
        eq(chatThreads.agentId, args.agentId),
        or(
          isNull(chatThreads.lastReadAt),
          gt(unreadThreads.latestReadWatermarkAt, chatThreads.lastReadAt),
        ),
      ),
    )
    .returning({ threadId: chatThreads.id });
  const updated = await executeRawRows(
    db,
    sql`WITH "updated_threads" AS (${updateEveryMatchingThread.getSQL()}) SELECT "id" FROM "updated_threads" LIMIT ${NOTIFIED_THREAD_ID_BUDGET + 1}`,
    updatedThreadRowSchema,
  );
  return updated.map((row) => {
    return row.id;
  });
}

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
    const updatedThreadIds = await markAgentThreadsRead(writeDb, {
      agentId,
      userId: auth.userId,
      orgId: auth.orgId,
    });
    signal.throwIfAborted();

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
