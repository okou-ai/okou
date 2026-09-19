import { CANCELLATION_RECOVERY_STALE_AFTER_MS } from "@okouai/api-contracts/contracts/runners";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { activeInputDeliveries } from "@okouai/db/schema/active-input-delivery";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import {
  and,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  lte,
  ne,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Db } from "../external/db";
import { nowDate } from "../../lib/time";
import { pendingChatQueueEventCondition } from "./chat-event-queue.service";
import { chatEventTypeIn } from "./chat-event-type.service";

const ACTIVE_CHAT_RUN_STATUSES = ["queued", "pending", "running"] as const;

interface ChatThreadAdmissionConditionArgs {
  readonly threadId: string;
  readonly excludeRunId?: string;
  readonly apiStartTime?: number;
}

function activeChatRunCondition(db: Pick<Db, "select">) {
  return and(
    isNotNull(agentRuns.triggerSource),
    inArray(agentRuns.status, ACTIVE_CHAT_RUN_STATUSES),
    or(
      notExists(
        db
          .select({ id: agentRunCallbacks.id })
          .from(agentRunCallbacks)
          .where(
            and(
              eq(agentRunCallbacks.runId, agentRuns.id),
              eq(agentRunCallbacks.internalKind, "chat"),
              isNotNull(sql`${agentRunCallbacks.payload}->>'queuedMessageId'`),
            ),
          ),
      ),
      exists(
        db
          .select({ id: chatEvents.id })
          .from(chatEvents)
          .where(
            and(
              eq(chatEvents.runId, agentRuns.id),
              chatEventTypeIn(["input.prompt"]),
            ),
          ),
      ),
    ),
  );
}

function unresolvedCancellationRecoveryCondition(
  db: Pick<Db, "select">,
  completedAtCondition: SQL,
) {
  return and(
    isNotNull(agentRuns.triggerSource),
    eq(agentRuns.status, "cancelled"),
    isNotNull(agentRuns.cancellationRecoveryCompleted),
    completedAtCondition,
    or(
      eq(agentRuns.cancellationRecoveryCompleted, false),
      notExists(
        db
          .select({ id: chatEvents.id })
          .from(chatEvents)
          .where(
            and(
              eq(chatEvents.runId, agentRuns.id),
              chatEventTypeIn(["run.cancelled"]),
            ),
          ),
      ),
    ),
  );
}

function freshUnresolvedCancellationRecoveryCondition(
  db: Pick<Db, "select">,
  apiStartTime?: number,
): SQL | undefined {
  return unresolvedCancellationRecoveryCondition(
    db,
    gt(
      agentRuns.completedAt,
      new Date(
        (apiStartTime ?? nowDate().getTime()) -
          CANCELLATION_RECOVERY_STALE_AFTER_MS,
      ),
    ),
  );
}

export async function cancellationRecoveryPendingForThread(
  db: Pick<Db, "select">,
  args: {
    readonly threadId: string;
  },
): Promise<boolean> {
  const [run] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.chatThreadId, args.threadId),
        freshUnresolvedCancellationRecoveryCondition(db),
      ),
    )
    .limit(1);

  return run !== undefined;
}

function chatThreadRunAdmissionBlockerExists(
  db: Pick<Db, "select">,
  args: ChatThreadAdmissionConditionArgs,
): SQL {
  return exists(
    db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.chatThreadId, args.threadId),
          args.excludeRunId === undefined
            ? undefined
            : ne(agentRuns.id, args.excludeRunId),
          or(
            activeChatRunCondition(db),
            freshUnresolvedCancellationRecoveryCondition(db, args.apiStartTime),
          ),
        ),
      ),
  );
}

function chatThreadOpenDeliveryExists(
  db: Pick<Db, "select">,
  threadId: string,
): SQL {
  return exists(
    db
      .select({ id: activeInputDeliveries.id })
      .from(activeInputDeliveries)
      .where(
        and(
          eq(activeInputDeliveries.chatThreadId, threadId),
          eq(activeInputDeliveries.status, "open"),
        ),
      ),
  );
}

export function chatThreadAdmissionBlockerCondition(
  db: Pick<Db, "select">,
  args: ChatThreadAdmissionConditionArgs,
): SQL {
  return sql`${chatThreadRunAdmissionBlockerExists(
    db,
    args,
  )} OR ${chatThreadOpenDeliveryExists(db, args.threadId)}`;
}

async function chatThreadAdmissionBlockerExists(
  db: Pick<Db, "select">,
  args: ChatThreadAdmissionConditionArgs,
): Promise<boolean> {
  const [thread] = await db
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.id, args.threadId),
        chatThreadAdmissionBlockerCondition(db, args),
      ),
    )
    .limit(1);
  return thread !== undefined;
}

// A managed browser outlives the run that opened it and the next run simply
// attaches to the same live instance, so it must not hold up the thread's next
// run.
export async function chatThreadAdmissionBlocked(
  db: Pick<Db, "select">,
  args: {
    readonly threadId: string;
    readonly excludeRunId?: string;
    readonly apiStartTime?: number;
  },
): Promise<boolean> {
  return await chatThreadAdmissionBlockerExists(db, args);
}

/** Pending queue threads whose cancellation recovery barrier has failed open. */
export async function expiredCancellationRecoveryThreads(
  db: Pick<Db, "select" | "selectDistinct">,
  args: {
    readonly expiredBefore: Date;
    readonly limit: number;
    readonly chatThreadIds?: readonly string[];
  },
): Promise<readonly { chatThreadId: string; userId: string }[]> {
  const rows = await db
    .selectDistinct({
      chatThreadId: chatEvents.chatThreadId,
      userId: chatThreads.userId,
    })
    .from(chatEvents)
    .innerJoin(chatThreads, eq(chatThreads.id, chatEvents.chatThreadId))
    .where(
      and(
        pendingChatQueueEventCondition(db),
        notExists(
          db
            .select({ id: agentRuns.id })
            .from(agentRuns)
            .where(
              and(
                eq(agentRuns.chatThreadId, chatEvents.chatThreadId),
                activeChatRunCondition(db),
              ),
            ),
        ),
        exists(
          db
            .select({ id: agentRuns.id })
            .from(agentRuns)
            .where(
              and(
                eq(agentRuns.chatThreadId, chatEvents.chatThreadId),
                unresolvedCancellationRecoveryCondition(
                  db,
                  lte(agentRuns.completedAt, args.expiredBefore),
                ),
              ),
            ),
        ),
        args.chatThreadIds === undefined
          ? undefined
          : inArray(chatEvents.chatThreadId, args.chatThreadIds),
      ),
    )
    .limit(args.limit);
  return rows;
}
