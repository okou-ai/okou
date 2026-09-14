import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import {
  chatEventTerminalPredicate,
  chatEvents,
} from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";

import type { Db } from "../external/db";

export function latestRunFinishEventSubquery(
  db: Pick<Db, "select">,
  threadId: string | typeof chatThreads.id,
) {
  return db
    .select({
      createdAt: chatEvents.createdAt,
    })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, threadId),
        chatEventTerminalPredicate(chatEvents.eventType),
      ),
    )
    .orderBy(sql`${desc(chatEvents.createdAt)} NULLS LAST`, desc(chatEvents.id))
    .limit(1)
    .as("latest_run_finish_message");
}

export function unreadChatThreadsQuery(
  db: Pick<Db, "select">,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly agentId?: string;
    readonly excludedThreadId?: string | null;
  },
) {
  const lastRunFinish = latestRunFinishEventSubquery(db, chatThreads.id);
  return db
    .select({
      threadId: chatThreads.id,
      unreadAt: lastRunFinish.createdAt,
    })
    .from(chatThreads)
    .innerJoin(agents, eq(agents.id, chatThreads.agentId))
    .crossJoinLateral(lastRunFinish)
    .where(
      and(
        eq(chatThreads.userId, args.userId),
        eq(agents.orgId, args.orgId),
        args.agentId ? eq(chatThreads.agentId, args.agentId) : undefined,
        args.excludedThreadId
          ? ne(chatThreads.id, args.excludedThreadId)
          : undefined,
        or(
          isNull(chatThreads.lastReadAt),
          gt(lastRunFinish.createdAt, chatThreads.lastReadAt),
        ),
        notExists(
          db
            .select({ id: agentRuns.id })
            .from(agentRuns)
            .where(
              and(
                eq(agentRuns.chatThreadId, chatThreads.id),
                inArray(agentRuns.status, ["queued", "pending", "running"]),
                isNotNull(agentRuns.triggerSource),
              ),
            ),
        ),
      ),
    );
}
