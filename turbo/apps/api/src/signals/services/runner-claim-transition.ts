import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { and, eq, exists, isNull, or, sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  array as zArray,
  number,
  object,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { runnerJobQueueExpiredCondition } from "./runner-job-queue-lifecycle.service";
import {
  claimedWorkflowSchema,
  workflowClaimSelectionSql,
  type ClaimedWorkflow,
  type WorkflowClaimInput,
} from "./workflow-claim.service";

export type ClaimTransitionResult =
  | {
      readonly status: "claimed";
      readonly claimedAt: Date;
      readonly workflows: readonly ClaimedWorkflow[];
    }
  | { readonly status: "workflow-unavailable" }
  | { readonly status: "job-not-found" }
  | { readonly status: "run-not-found" };

export const claimTransitionSqlRowSchema = object({
  status: zEnum([
    "claimed",
    "job-not-found",
    "run-not-found",
    "invariant-error",
    "workflow-unavailable",
  ]),
  claimedAtMs: number().nullable(),
  workflows: zArray(claimedWorkflowSchema),
});

export function decodeClaimTransitionResult(
  rows: readonly zInfer<typeof claimTransitionSqlRowSchema>[],
): ClaimTransitionResult {
  const row = rows[0];
  if (!row || row.status === "invariant-error") {
    throw new Error("Runner job claim transition violated its invariant");
  }
  if (row.status === "claimed") {
    if (row.claimedAtMs === null) {
      throw new Error("Claimed runner job is missing its transition time");
    }
    return {
      status: "claimed",
      claimedAt: new Date(row.claimedAtMs),
      workflows: row.workflows,
    };
  }
  return { status: row.status };
}

/** Consume the eligible locked Run/claim clock before the Run transition. */
function buildClaimThreadStartSql(): SQL {
  const dialect = new PgDialect();
  // Like native publication, an identity write arbitrates against slot release.
  // Only the first executable claim may invalidate the previous native binding.
  const threadOwner = dialect.buildUpdateQuery({
    table: activeAgentRuns,
    set: {
      runId: sql`${activeAgentRuns.runId}`,
      lastHeartbeatAt: sql`claim_clock."claimedAt"`,
    },
    from: sql`locked_run, claim_clock, workflow_admission`,
    joins: [],
    where: and(
      eq(activeAgentRuns.runId, sql`locked_run."id"`),
      sql`${activeAgentRuns.chatThreadId} IS NOT DISTINCT FROM locked_run."chatThreadId"`,
      eq(activeAgentRuns.userId, sql`locked_run."userId"`),
      eq(activeAgentRuns.orgId, sql`locked_run."orgId"`),
    ),
    returning: [{ path: ["runId"], field: activeAgentRuns.runId }],
  });
  const threadStart = dialect.buildUpdateQuery({
    table: chatThreads,
    set: {
      framework: sql`NULL`,
      frameworkSessionId: sql`NULL`,
      frameworkSessionRunId: sql`locked_run."id"`,
    },
    from: sql`locked_run, claimed_thread_owner`,
    joins: [],
    where: and(
      eq(chatThreads.id, sql`locked_run."chatThreadId"`),
      eq(chatThreads.userId, sql`locked_run."userId"`),
      eq(chatThreads.agentId, sql`locked_run."agentId"`),
      sql`claimed_thread_owner."run_id" = locked_run."id"`,
    ),
    returning: [{ path: ["id"], field: chatThreads.id }],
  });
  return sql`claimed_thread_owner AS (${threadOwner}),
             started_thread AS (${threadStart})`;
}

export function buildClaimTransitionSql(
  runId: string,
  runner: {
    readonly id: string | null;
    readonly heartbeatGeneration: number | null;
    readonly hostname: string | null;
    readonly version: string | null;
  },
  workflowInput: WorkflowClaimInput,
): SQL {
  // Materialized outputs make the row locks depend on run, then queue.
  return sql`
          WITH locked_run AS MATERIALIZED (
            SELECT
              ${agentRuns.id} AS "id",
              ${agentRuns.status} AS "status",
              ${agentRuns.chatThreadId} AS "chatThreadId",
              ${agentRuns.agentId} AS "agentId",
              ${agentRuns.userId} AS "userId",
              ${agentRuns.orgId} AS "orgId",
              ${agentRuns.triggerSource} AS "triggerSource",
              ${agentRuns.workflowAutomationId} AS "workflowAutomationId"
            FROM ${agentRuns}
            WHERE ${eq(agentRuns.id, runId)}
            FOR UPDATE
          ),
          locked_job AS MATERIALIZED (
            SELECT
              ${runnerJobQueue.runId} AS "runId",
              ${runnerJobQueueExpiredCondition()} AS "isExpired"
            FROM ${runnerJobQueue}
            INNER JOIN locked_run
              ON locked_run."id" = ${runnerJobQueue.runId}
            FOR UPDATE OF ${runnerJobQueue}
          ),
          ${workflowClaimSelectionSql(workflowInput)},
          claim_clock AS MATERIALIZED (
            SELECT
              date_trunc(
                'milliseconds',
                clock_timestamp() AT TIME ZONE 'UTC'
              ) AS "claimedAt"
            FROM locked_run
            INNER JOIN locked_job
              ON locked_job."runId" = locked_run."id"
            WHERE
              locked_run."status" = 'pending'
              AND NOT locked_job."isExpired"
              AND EXISTS (SELECT 1 FROM workflow_admission)
          ),
          ${buildClaimThreadStartSql()},
          updated_run AS (
            UPDATE ${agentRuns}
            SET
              status = 'running',
              started_at = claim_clock."claimedAt",
              cancellation_recovery_completed = false,
              runner_id = ${runner.id},
              runner_heartbeat_generation = ${runner.heartbeatGeneration},
              runner_hostname = ${runner.hostname},
              runner_version = ${runner.version}
            FROM locked_run
            INNER JOIN locked_job
              ON locked_job."runId" = locked_run."id"
            CROSS JOIN claim_clock
            WHERE ${and(
              eq(agentRuns.id, sql`locked_run."id"`),
              eq(agentRuns.status, sql`'pending'`),
              exists(sql`(SELECT 1 FROM claimed_thread_owner)`),
              or(
                isNull(sql`locked_run."chatThreadId"`),
                exists(sql`(SELECT 1 FROM started_thread)`),
              ),
            )}
            RETURNING ${agentRuns.id} AS "id", ${agentRuns.startedAt} AS "claimedAt"
          ),
          deleted_job AS (
            DELETE FROM ${runnerJobQueue}
            USING locked_run, locked_job
            WHERE ${and(
              eq(runnerJobQueue.runId, sql`locked_job."runId"`),
              sql`locked_job."runId" = locked_run."id"`,
              sql`(
                locked_run."status" <> 'pending'
                OR EXISTS (
                  SELECT 1
                  FROM updated_run
                  WHERE updated_run."id" = locked_run."id"
                )
              )`,
            )}
            RETURNING ${runnerJobQueue.runId} AS "runId"
          )
          SELECT
            CASE
              WHEN NOT EXISTS (SELECT 1 FROM locked_run)
                THEN 'run-not-found'
              WHEN EXISTS (
                SELECT 1
                FROM locked_run
                WHERE locked_run."status" <> 'pending'
              )
                THEN 'run-not-found'
              WHEN NOT EXISTS (SELECT 1 FROM locked_job)
                OR EXISTS (
                  SELECT 1
                  FROM locked_job
                  WHERE locked_job."isExpired"
                )
                THEN 'job-not-found'
              WHEN EXISTS (SELECT 1 FROM updated_run)
                AND EXISTS (SELECT 1 FROM deleted_job)
                THEN 'claimed'
              WHEN NOT EXISTS (SELECT 1 FROM workflow_admission)
                THEN 'workflow-unavailable'
              ELSE 'invariant-error'
            END AS "status",
            (
              SELECT
                (
                  EXTRACT(EPOCH FROM updated_run."claimedAt") * 1000
                )::double precision
              FROM updated_run
            ) AS "claimedAtMs",
            CASE WHEN EXISTS (SELECT 1 FROM updated_run) THEN (SELECT documents FROM workflow_selection) ELSE '[]'::jsonb END AS workflows
          `;
}
