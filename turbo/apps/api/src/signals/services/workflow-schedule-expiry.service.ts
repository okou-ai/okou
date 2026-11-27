import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { and, eq, sql } from "drizzle-orm";

import { command } from "ccstate";
import { writeDb$ } from "../external/db";

import { calculateNextRun } from "./time-automation";

type Automation = typeof workflowAutomations.$inferSelect;

function workflowScheduleHasQueuedInputSql(current: Automation) {
  return sql`EXISTS (
    SELECT 1 FROM workflow_user_automation_threads binding
    JOIN chat_events event ON event.chat_thread_id = binding.chat_thread_id
    JOIN chat_automation_context context ON context.id = event.context_id
    WHERE binding.org_id = ${current.orgId} AND binding.user_id = ${current.ownerUserId}
      AND binding.workflow_id = ${current.workflowId}::uuid
      AND event.event_type = 'input.automation' AND event.run_id IS NULL
      AND event.context_type = 'automation' AND context.automation_id = ${current.id}::uuid
      AND NOT EXISTS (SELECT 1 FROM chat_events revoked WHERE revoked.revokes_event_id = event.id)
  )`;
}

function futureAfterSkip(current: Automation, at: Date): Date | null {
  if (current.scheduleType === "cron" && current.cronExpression) {
    return calculateNextRun(current.cronExpression, current.timezone, at);
  }
  if (current.scheduleType === "loop" && current.intervalSeconds !== null) {
    return new Date(at.getTime() + current.intervalSeconds * 1000);
  }
  return null;
}

function skippedScheduleValues(
  current: Automation,
  nextRunAt: Date | null,
  at: Date,
) {
  return {
    nextRunAt,
    ...(current.scheduleType === "once" ? { enabled: false } : {}),
    deferredAnchorAt: null,
    deferredUntil: null,
    deferredReason: null,
    updatedAt: at,
  };
}

/**
 * Move past one unclaimed occurrence of a recurring schedule whose owner is not
 * served now. Like an expired slot, no Run, failure, queue event or expiry
 * marker is created, and the next occurrence decides again. Returns false
 * when the occurrence was claimed or moved concurrently.
 */
export const skipInactiveOwnerSchedule$ = command(
  async (
    { set },
    args: { readonly automation: Automation; readonly at: Date },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const { automation, at } = args;
    const anchor = automation.nextRunAt;
    const nextRunAt = futureAfterSkip(automation, at);
    if (
      anchor === null ||
      nextRunAt === null ||
      nextRunAt.getTime() <= at.getTime()
    ) {
      return false;
    }
    const [advanced] = await set(writeDb$)
      .update(workflowAutomations)
      .set(skippedScheduleValues(automation, nextRunAt, at))
      .where(
        and(
          eq(workflowAutomations.id, automation.id),
          eq(workflowAutomations.enabled, true),
          eq(workflowAutomations.nextRunAt, anchor),
          sql`NOT ${workflowScheduleHasQueuedInputSql(automation)}`,
        ),
      )
      .returning({ id: workflowAutomations.id });
    signal.throwIfAborted();
    return advanced !== undefined;
  },
);
