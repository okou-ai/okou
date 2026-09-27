import { CANCELLATION_RECOVERY_STALE_AFTER_MS } from "@okouai/api-contracts/contracts/runners";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import {
  and,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notExists,
  or,
  type SQL,
} from "drizzle-orm";
import type { Db } from "../external/db";
import { nowDate } from "../../lib/time";
import { chatEventTypeIn } from "./chat-event-type.service";

interface ChatThreadAdmissionConditionArgs {
  readonly threadId: string;
  readonly excludeRunId?: string;
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

/**
 * A thread is busy while it holds an active run row. The row lives from launch
 * until the Runner finishes with the run (completion, or timeout cleanup), so
 * it also covers cancellation recovery and open active-input deliveries.
 */
export function chatThreadAdmissionBlockerCondition(
  db: Pick<Db, "select">,
  args: ChatThreadAdmissionConditionArgs,
): SQL {
  return exists(
    db
      .select({ runId: activeAgentRuns.runId })
      .from(activeAgentRuns)
      .where(
        and(
          eq(activeAgentRuns.chatThreadId, args.threadId),
          args.excludeRunId === undefined
            ? undefined
            : ne(activeAgentRuns.runId, args.excludeRunId),
        ),
      ),
  );
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
  },
): Promise<boolean> {
  return await chatThreadAdmissionBlockerExists(db, args);
}

/**
 * Recheck a cancellation recovery barrier for this long after it fails open.
 * Older barriers are left to normal per-thread admission and callback paths,
 * matching the stale queue repair window.
 */
const CANCELLATION_RECOVERY_SWEEP_WINDOW_MS = 10 * 60_000;

/**
 * Pending queue threads whose cancellation recovery barrier failed open within
 * the sweep window. Each step is a bounded single-table read; the drain itself
 * re-checks admission, so a thread with a live run is only a wasted drain.
 */
export async function expiredCancellationRecoveryThreads(
  db: Pick<Db, "select">,
  args: {
    readonly expiredBefore: Date;
    readonly limit: number;
    readonly chatThreadIds?: readonly string[];
  },
): Promise<readonly { chatThreadId: string; userId: string; orgId: string }[]> {
  const runs = await db
    .select({
      id: agentRuns.id,
      orgId: agentRuns.orgId,
      chatThreadId: agentRuns.chatThreadId,
      cancellationRecoveryCompleted: agentRuns.cancellationRecoveryCompleted,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.status, "cancelled"),
        isNotNull(agentRuns.triggerSource),
        isNotNull(agentRuns.cancellationRecoveryCompleted),
        gt(
          agentRuns.completedAt,
          new Date(
            args.expiredBefore.getTime() -
              CANCELLATION_RECOVERY_SWEEP_WINDOW_MS,
          ),
        ),
        lte(agentRuns.completedAt, args.expiredBefore),
        args.chatThreadIds === undefined
          ? isNotNull(agentRuns.chatThreadId)
          : inArray(agentRuns.chatThreadId, args.chatThreadIds),
      ),
    )
    .limit(args.limit);
  const recoveredRunIds = runs
    .filter((run) => {
      return run.cancellationRecoveryCompleted === true;
    })
    .map((run) => {
      return run.id;
    });
  const cancelledEventRunIds = new Set(
    recoveredRunIds.length === 0
      ? []
      : (
          await db
            .select({ runId: chatEvents.runId })
            .from(chatEvents)
            .where(
              and(
                inArray(chatEvents.runId, recoveredRunIds),
                chatEventTypeIn(["run.cancelled"]),
              ),
            )
        ).map((event) => {
          return event.runId;
        }),
  );
  // Maps each unresolved thread to its organization, taken from the run.
  const unresolvedThreadIds = new Map<string, string>();
  for (const run of runs) {
    if (
      run.chatThreadId !== null &&
      (run.cancellationRecoveryCompleted === false ||
        !cancelledEventRunIds.has(run.id))
    ) {
      unresolvedThreadIds.set(run.chatThreadId, run.orgId);
    }
  }
  // A revoked run-less input also matches; the drain skips it.
  const pendingThreadIds: string[] = [];
  for (const chatThreadId of unresolvedThreadIds.keys()) {
    const [pending] = await db
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.chatThreadId, chatThreadId),
          isNull(chatEvents.runId),
          chatEventTypeIn(["input.prompt", "input.automation"]),
        ),
      )
      .limit(1);
    if (pending) {
      pendingThreadIds.push(chatThreadId);
    }
  }
  if (pendingThreadIds.length === 0) {
    return [];
  }
  const threads = await db
    .select({ chatThreadId: chatThreads.id, userId: chatThreads.userId })
    .from(chatThreads)
    .where(inArray(chatThreads.id, pendingThreadIds));
  return threads.flatMap((thread) => {
    const orgId = unresolvedThreadIds.get(thread.chatThreadId);
    return orgId === undefined ? [] : [{ ...thread, orgId }];
  });
}
