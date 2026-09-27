import { CANCELLATION_RECOVERY_STALE_AFTER_MS } from "@okouai/api-contracts/contracts/runners";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import {
  and,
  eq,
  exists,
  gt,
  isNotNull,
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

// A managed browser outlives the run that opened it and the next run simply
// attaches to the same live instance, so it must not hold up the thread's next
// run.
