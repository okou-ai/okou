import { CANCELLATION_RECOVERY_STALE_AFTER_MS } from "@okouai/api-contracts/contracts/runners";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { and, eq, gt, isNotNull, notExists, or, type SQL } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { computed } from "ccstate";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { db$ } from "../external/db";
import { chatEventTypeIn } from "./chat-event-type.service";

function unresolvedCancellationRecoveryCondition(completedAtCondition: SQL) {
  return and(
    isNotNull(agentRuns.triggerSource),
    eq(agentRuns.status, "cancelled"),
    isNotNull(agentRuns.cancellationRecoveryCompleted),
    completedAtCondition,
    or(
      eq(agentRuns.cancellationRecoveryCompleted, false),
      notExists(
        new QueryBuilder()
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
  apiStartTime?: number,
): SQL | undefined {
  return unresolvedCancellationRecoveryCondition(
    gt(
      agentRuns.completedAt,
      new Date(
        (apiStartTime ?? nowDate().getTime()) -
          CANCELLATION_RECOVERY_STALE_AFTER_MS,
      ),
    ),
  );
}

export function cancellationRecoveryPendingForThread(args: {
  readonly threadId: string;
}) {
  return computed(async (get): Promise<boolean> => {
    const [run] = await get(db$)
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.chatThreadId, args.threadId),
          freshUnresolvedCancellationRecoveryCondition(),
        ),
      )
      .limit(1);

    return run !== undefined;
  });
}

// A managed browser outlives the run that opened it and the next run simply
// attaches to the same live instance, so it must not hold up the thread's next
// run.
