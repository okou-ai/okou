import { command } from "ccstate";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { workflows } from "@okouai/db/schema/workflow";
import {
  PROACTIVE_JOBS_BLUEPRINT_KEY,
  PROACTIVE_JOBS_INTERVAL_SECONDS,
} from "@okouai/api-contracts/contracts/proactive-jobs";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import type { InternalRunCallbackEnvelope } from "./internal-run-callback";
import { jobsOwnerEnabledSql, runnableJobsExistSql } from "./user-jobs-query";
import { loadProactiveWorkflowsEligibility$ } from "./proactive-workflows-eligibility.service";
import { logger } from "../../lib/log";
import { settle } from "../utils";

const log = logger("ProactiveJobsSettlement");

/** The existing callback identity acknowledges exactly one completion and successor. */
export const settleProactiveJobsRun$ = command(
  async (
    { set },
    automationId: string,
    callback: InternalRunCallbackEnvelope,
    signal: AbortSignal,
  ) => {
    const database = set(writeDb$);
    const [row] = await database
      .select({
        orgId: workflowAutomations.orgId,
        userId: workflowAutomations.ownerUserId,
        agentId: workflows.agentId,
        blueprint: workflowAutomations.officialBlueprintKey,
        failureReason: agentRuns.failureReason,
        runId: agentRuns.id,
        runStatus: agentRuns.status,
        completedAt: agentRuns.completedAt,
      })
      .from(workflowAutomations)
      .innerJoin(workflows, eq(workflows.id, workflowAutomations.workflowId))
      .leftJoin(
        agentRuns,
        and(
          eq(agentRuns.id, callback.runId),
          eq(agentRuns.workflowAutomationId, workflowAutomations.id),
          eq(agentRuns.orgId, workflowAutomations.orgId),
        ),
      )
      .where(eq(workflowAutomations.id, automationId))
      .limit(1);
    signal.throwIfAborted();
    if (!row || row.blueprint !== PROACTIVE_JOBS_BLUEPRINT_KEY) {
      return false;
    }
    if (
      row.runId === null ||
      (row.runStatus !== "completed" &&
        row.runStatus !== "failed" &&
        row.runStatus !== "cancelled")
    ) {
      return true;
    }
    if (row.completedAt === null) {
      throw new Error("Terminal Jobs run has no completion time");
    }
    if (!callback.callbackId) {
      throw new Error(
        "Jobs completion requires its persisted callback identity",
      );
    }
    const eligibility = await set(
      loadProactiveWorkflowsEligibility$,
      row,
      signal,
    );
    const at = nowDate();
    const next = new Date(
      row.completedAt.getTime() + PROACTIVE_JOBS_INTERVAL_SECONDS * 1000,
    );
    const success = row.runStatus === "completed";
    const increment = !success && row.failureReason !== "insufficient_credits";
    const failures = success
      ? sql`0`
      : sql`${workflowAutomations.consecutiveFailures} + ${increment ? 1 : 0}`;
    const receipt = database
      .update(agentRunCallbacks)
      .set({ status: "delivered", deliveredAt: at, lastError: null })
      .where(
        and(
          eq(agentRunCallbacks.id, callback.callbackId),
          eq(agentRunCallbacks.runId, callback.runId),
          isNull(agentRunCallbacks.deliveredAt),
        ),
      )
      .returning({ id: agentRunCallbacks.id });
    await database.execute(sql`WITH accepted_jobs_completion AS (${receipt.getSQL()})
    UPDATE workflow_automations SET
      consecutive_failures = ${failures},
      enabled = CASE WHEN ${failures} >= 3 THEN false ELSE workflow_automations.enabled END,
      next_run_at = CASE WHEN ${failures} < 3 AND ${eligibility.jobs.active && eligibility.agentId === row.agentId}
        AND ${jobsOwnerEnabledSql(row, row.agentId)} AND ${runnableJobsExistSql(row)} THEN ${sql.param(next, workflowAutomations.nextRunAt)}::timestamp ELSE NULL END,
      updated_at = ${sql.param(at, workflowAutomations.updatedAt)}
    WHERE id = ${automationId}::uuid AND last_run_id = ${callback.runId}::uuid AND enabled = true
      AND official_blueprint_key = ${PROACTIVE_JOBS_BLUEPRINT_KEY} AND next_run_at IS NULL
      AND EXISTS (SELECT 1 FROM accepted_jobs_completion)`);
    signal.throwIfAborted();
    return true;
  },
);

/** Repair a missed terminal callback from its existing durable identity. */
export const reconcilePendingProactiveJobsCompletions$ = command(
  async ({ set }, signal: AbortSignal) => {
    const rows = await set(writeDb$)
      .select({
        callbackId: agentRunCallbacks.id,
        runId: agentRuns.id,
        status: agentRuns.status,
        automationId: workflowAutomations.id,
      })
      .from(agentRunCallbacks)
      .innerJoin(agentRuns, eq(agentRuns.id, agentRunCallbacks.runId))
      .innerJoin(
        workflowAutomations,
        and(
          eq(workflowAutomations.id, agentRuns.workflowAutomationId),
          eq(workflowAutomations.lastRunId, agentRuns.id),
        ),
      )
      .where(
        and(
          eq(
            workflowAutomations.officialBlueprintKey,
            PROACTIVE_JOBS_BLUEPRINT_KEY,
          ),
          eq(agentRunCallbacks.internalKind, "workflow-automation:loop"),
          isNull(agentRunCallbacks.deliveredAt),
          inArray(agentRuns.status, ["completed", "failed", "cancelled"]),
        ),
      )
      .orderBy(asc(agentRunCallbacks.createdAt), asc(agentRunCallbacks.id))
      .limit(100);
    signal.throwIfAborted();
    for (const row of rows) {
      const callback: InternalRunCallbackEnvelope =
        row.status === "completed"
          ? {
              callbackId: row.callbackId,
              runId: row.runId,
              status: "completed",
              payload: null,
            }
          : {
              callbackId: row.callbackId,
              runId: row.runId,
              status: "failed",
              error: "Scheduled Jobs execution failed",
              payload: null,
            };
      const result = await settle(
        set(settleProactiveJobsRun$, row.automationId, callback, signal),
        signal,
      );
      if (!result.ok) {
        log.error("Could not settle a completed Jobs run", {
          runId: row.runId,
          error: result.error,
        });
      }
    }
  },
);
