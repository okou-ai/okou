import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { and, eq, exists, isNull, or, sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { z } from "zod";
import { runnerJobQueueExpiredCondition } from "./runner-job-queue-lifecycle.service";

export type ClaimTransitionResult =
  | { readonly status: "claimed"; readonly claimedAt: Date }
  | { readonly status: "job-not-found" }
  | { readonly status: "run-not-found" };

export const claimTransitionSqlRowSchema = z.object({
  status: z.enum([
    "claimed",
    "job-not-found",
    "run-not-found",
    "invariant-error",
  ]),
  claimedAtMs: z.number().nullable(),
});

export function decodeClaimTransitionResult(
  rows: readonly z.infer<typeof claimTransitionSqlRowSchema>[],
): ClaimTransitionResult {
  const row = rows[0];
  if (!row || row.status === "invariant-error") {
    throw new Error("Runner job claim transition violated its invariant");
  }
  if (row.status === "claimed") {
    if (row.claimedAtMs === null) {
      throw new Error("Claimed runner job is missing its transition time");
    }
    return { status: "claimed", claimedAt: new Date(row.claimedAtMs) };
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
    set: { runId: sql`${activeAgentRuns.runId}` },
    from: sql`locked_run, claim_clock`,
    joins: [],
    where: and(
      eq(activeAgentRuns.runId, sql`locked_run."id"`),
      eq(activeAgentRuns.chatThreadId, sql`locked_run."chatThreadId"`),
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
  runnerId: string | null,
  runnerHeartbeatGeneration: number | null,
  runnerHostname: string | null,
  runnerVersion: string | null,
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
              ${agentRuns.orgId} AS "orgId"
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
          ),
          ${buildClaimThreadStartSql()},
          updated_run AS (
            UPDATE ${agentRuns}
            SET
              status = 'running',
              started_at = claim_clock."claimedAt",
              cancellation_recovery_completed = false,
              runner_id = ${runnerId},
              runner_heartbeat_generation = ${runnerHeartbeatGeneration},
              runner_hostname = ${runnerHostname},
              runner_version = ${runnerVersion}
            FROM locked_run
            INNER JOIN locked_job
              ON locked_job."runId" = locked_run."id"
            CROSS JOIN claim_clock
            WHERE ${and(
              eq(agentRuns.id, sql`locked_run."id"`),
              eq(agentRuns.status, sql`'pending'`),
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
              ELSE 'invariant-error'
            END AS "status",
            (
              SELECT
                (
                  EXTRACT(EPOCH FROM updated_run."claimedAt") * 1000
                )::double precision
              FROM updated_run
            ) AS "claimedAtMs"
          `;
}
