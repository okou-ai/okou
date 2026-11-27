import { dispatchableWorkflowCondition } from "./workflow-visibility";
import { workflowAutomationSnapshotCondition } from "./workflow-automation-snapshot";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { eq, sql, type SQL } from "drizzle-orm";
import type { WorkflowRecurringScheduleClaim } from "./workflow-automation-enqueue.service";
import {
  currentWorkflowAutomationBindingSql,
  type WorkflowAutomationBinding,
} from "./workflow-input-queue.service";

export function consumeRecurringWorkflowScheduleCtes(
  binding: WorkflowAutomationBinding,
  claim: WorkflowRecurringScheduleClaim,
  eligibility: SQL,
) {
  const observation = workflowAutomationSnapshotCondition(
    claim.automationSnapshot,
  );
  if (!observation) {
    throw new Error("Recurring schedule requires its source observation");
  }
  const condition = sql`${eligibility} AND ${observation} AND ${dispatchableWorkflowCondition()}
    AND ${workflowAutomations.kind} = 'schedule'
    AND ${workflowAutomations.officialBlueprintKey} IS NULL
    AND ${workflowAutomations.scheduleType} IN ('cron', 'loop')
    AND ${eq(workflowAutomations.nextRunAt, claim.scheduledAnchorAt)}`;
  return [
    sql`workflow_current_schedule AS MATERIALIZED (${currentWorkflowAutomationBindingSql(binding, condition, "schedule-claim")})`,
    sql`workflow_consumed_claim AS (
      UPDATE ${workflowAutomations}
      SET next_run_at = NULL,
        last_run_at = ${sql.param(claim.claimedAt, workflowAutomations.lastRunAt)},
        updated_at = ${sql.param(claim.claimedAt, workflowAutomations.updatedAt)}
      FROM workflow_current_schedule
      WHERE ${workflowAutomations.id} = workflow_current_schedule.id
      RETURNING ${workflowAutomations.id}
    )`,
  ];
}
