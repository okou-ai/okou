import { command } from "ccstate";
import { and, eq, isNull, lt, not, sql } from "drizzle-orm";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { workflows } from "@okouai/db/schema/workflow";
import {
  PROACTIVE_JOBS_BLUEPRINT_KEY,
  PROACTIVE_JOBS_DEFINITION_NAME,
} from "@okouai/api-contracts/contracts/proactive-jobs";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  jobsOwnerEnabledSql,
  runnableJobsExistSql,
  type JobOwner,
} from "./user-jobs-query";
import { loadProactiveWorkflowsEligibility$ } from "./proactive-workflows-eligibility.service";

/** Retain the enabled loop while removing its idle successor anchor. */
export const sleepIdleProactiveJobs$ = command(
  async ({ set }, owner: JobOwner, signal: AbortSignal) => {
    await set(writeDb$)
      .update(workflowAutomations)
      .set({ nextRunAt: null, updatedAt: nowDate() })
      .where(
        and(
          eq(workflowAutomations.orgId, owner.orgId),
          eq(workflowAutomations.ownerUserId, owner.userId),
          eq(
            workflowAutomations.officialBlueprintKey,
            PROACTIVE_JOBS_BLUEPRINT_KEY,
          ),
          eq(workflowAutomations.enabled, true),
          not(runnableJobsExistSql(owner)),
        ),
      );
    signal.throwIfAborted();
  },
);

/** Wake an idle anchor. Pending inputs and unfinished callbacks retain their owner. */
export const wakeProactiveJobs$ = command(
  async ({ set }, owner: JobOwner, signal: AbortSignal) => {
    const eligibility = await set(
      loadProactiveWorkflowsEligibility$,
      owner,
      signal,
    );
    if (!eligibility.jobs.active || eligibility.agentId === null) {
      return;
    }
    const database = set(writeDb$);
    const installation = database
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          eq(workflows.orgId, owner.orgId),
          eq(workflows.ownerUserId, owner.userId),
          eq(workflows.agentId, eligibility.agentId),
          eq(workflows.officialDefinitionName, PROACTIVE_JOBS_DEFINITION_NAME),
          eq(workflows.officialInstallationState, "installed"),
        ),
      );
    await database
      .update(workflowAutomations)
      .set({ nextRunAt: nowDate(), updatedAt: nowDate() })
      .where(
        and(
          eq(workflowAutomations.orgId, owner.orgId),
          eq(workflowAutomations.ownerUserId, owner.userId),
          eq(workflowAutomations.enabled, true),
          eq(workflowAutomations.officialIntendedEnabled, true),
          eq(workflowAutomations.officialReconciliationStatus, "current"),
          eq(
            workflowAutomations.officialBlueprintKey,
            PROACTIVE_JOBS_BLUEPRINT_KEY,
          ),
          lt(workflowAutomations.consecutiveFailures, 3),
          isNull(workflowAutomations.nextRunAt),
          sql`${workflowAutomations.workflowId} IN (${installation})`,
          jobsOwnerEnabledSql(owner, eligibility.agentId),
          runnableJobsExistSql(owner),
          sql`NOT EXISTS (SELECT 1 FROM agent_runs AS running WHERE running.workflow_automation_id = ${workflowAutomations.id} AND running.status IN ('pending', 'running'))`,
          sql`NOT EXISTS (SELECT 1 FROM agent_runs AS terminal JOIN agent_run_callbacks AS callback ON callback.run_id = terminal.id WHERE terminal.workflow_automation_id = ${workflowAutomations.id} AND terminal.id = ${workflowAutomations.lastRunId} AND callback.internal_kind = 'workflow-automation:loop' AND callback.delivered_at IS NULL)`,
          sql`NOT EXISTS (SELECT 1 FROM chat_events AS pending JOIN chat_automation_context AS context ON context.id = pending.context_id WHERE context.automation_id = ${workflowAutomations.id} AND pending.run_id IS NULL AND pending.event_type = 'input.automation' AND NOT EXISTS (SELECT 1 FROM chat_events AS revoker WHERE revoker.revokes_event_id = pending.id))`,
        ),
      );
    signal.throwIfAborted();
  },
);
