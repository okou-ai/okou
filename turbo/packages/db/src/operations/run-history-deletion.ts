import { count, eq, sql } from "drizzle-orm";
import { literal, number, object, string, uuid } from "zod";
import { agentRuns } from "../runtime/agent-run";
import { usageEvent } from "../runtime/usage-event";
import { agentRunCallbacks } from "../schema/agent-run-callback";
import { runnerJobQueue } from "../schema/runner-job-queue";
import { blobs } from "../schema/blob";
import { claimedWorkflowAttachments } from "../schema/claimed-workflow-attachment";
export function agentRunDeletionMembership(agentIds: readonly string[]) {
  return eq(agentRuns.agentId, sql`ANY(${sql.param(agentIds)}::uuid[])`);
}

export const deletedRunHistorySchema = object({
  id: uuid(),
  hash: string().nullable(),
});

/**
 * Delete exactly the caller's admitted Run set and return its held references.
 * DELETE RETURNING observes the winning Run row after any writer wait. Reading
 * the hash before DELETE would release stale evidence. Historical backfill moves
 * the existing archive retain to Run without creating another reference.
 *
 * Callers hold the admitted Run rows FOR UPDATE before this statement. Explicit
 * child cleanup preserves the current CASCADE / SET NULL effects and prepares
 * those callers for restrictive Run references. Consume every cleanup stream
 * before deleting the Run; its RETURNING remains the reference-release source.
 */
export function deleteRunHistoriesSql(runIds: readonly string[]) {
  return sql`WITH deleted_callbacks AS (
      DELETE FROM ${agentRunCallbacks}
      WHERE ${eq(agentRunCallbacks.runId, sql`ANY(${sql.param(runIds)}::uuid[])`)}
      RETURNING ${agentRunCallbacks.id}
    ), deleted_jobs AS (
      DELETE FROM ${runnerJobQueue}
      WHERE ${eq(runnerJobQueue.runId, sql`ANY(${sql.param(runIds)}::uuid[])`)}
      RETURNING ${runnerJobQueue.runId}
    ), detached_usage AS (
      UPDATE ${usageEvent}
      SET ${sql.identifier(usageEvent.runId.name)} = NULL
      WHERE ${eq(usageEvent.runId, sql`ANY(${sql.param(runIds)}::uuid[])`)}
      RETURNING ${usageEvent.id}
    )
    DELETE FROM ${agentRuns}
    WHERE ${eq(agentRuns.id, sql`ANY(${sql.param(runIds)}::uuid[])`)}
      AND (
        (SELECT ${count()} FROM deleted_callbacks) +
        (SELECT ${count()} FROM deleted_jobs) +
        (SELECT ${count()} FROM detached_usage)
      ) >= 0
    RETURNING ${agentRuns.id} AS id,
      ${agentRuns.legacyConversationHistoryHash} AS hash`;
}

/** One admitted threadless Run owns at most one historical blob reference. */
export const threadlessRunDeletionOutcomeSchema = object({
  deletedRuns: number().int().min(0).max(1),
  releasedReferences: number().int().min(0).max(1),
  complete: literal(1),
});

/**
 * Requires restrictive callback, job and usage Run FKs. A late pending child
 * must reject the parent DELETE, never disappear through CASCADE or SET NULL.
 * The owning Run lock and final nonblocking blob lock retain their old order.
 */
export function deleteThreadlessRunHistorySql(input: {
  readonly runId: string;
  readonly status: string;
  readonly completedAt: Date | null;
  readonly cancellationRecoveryCompleted: boolean | null;
  readonly quietBefore: Date;
}) {
  return sql`WITH locked_run AS MATERIALIZED (
      SELECT ${agentRuns.id} AS id, ${agentRuns.status} AS status,
        ${agentRuns.completedAt} AS completed_at,
        ${agentRuns.cancellationRecoveryCompleted} AS cancellation_recovery_completed,
        ${agentRuns.triggerSource} AS trigger_source,
        ${agentRuns.chatThreadId} AS chat_thread_id
      FROM ${agentRuns}
      WHERE ${agentRuns.id} = ${sql.param(input.runId, agentRuns.id)}
      FOR UPDATE
    ), eligible_run AS MATERIALIZED (
      SELECT id FROM locked_run
      WHERE status = ${sql.param(input.status, agentRuns.status)}
        AND status IN ('completed', 'failed', 'cancelled', 'timeout')
        AND date_trunc('milliseconds', completed_at) = ${sql.param(input.completedAt, agentRuns.completedAt)}::timestamp
        AND date_trunc('milliseconds', completed_at) <= ${sql.param(input.quietBefore, agentRuns.completedAt)}::timestamp
        AND cancellation_recovery_completed IS NOT DISTINCT FROM
          ${sql.param(input.cancellationRecoveryCompleted, agentRuns.cancellationRecoveryCompleted)}
        AND trigger_source IS NOT NULL AND chat_thread_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM ${claimedWorkflowAttachments}
          WHERE ${claimedWorkflowAttachments.runId} = locked_run.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${agentRunCallbacks}
          WHERE ${agentRunCallbacks.runId} = locked_run.id
            AND ${agentRunCallbacks.status} = 'pending'
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${runnerJobQueue}
          WHERE ${runnerJobQueue.runId} = locked_run.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${usageEvent}
          WHERE ${usageEvent.runId} = locked_run.id
            AND ${usageEvent.status} = 'pending'
        )
    ), removed_callbacks AS (
      DELETE FROM ${agentRunCallbacks}
      WHERE ${agentRunCallbacks.runId} IN (SELECT id FROM eligible_run)
        AND ${agentRunCallbacks.status} <> 'pending'
      RETURNING ${agentRunCallbacks.id}
    ), detached_usage AS (
      UPDATE ${usageEvent} SET ${sql.identifier(usageEvent.runId.name)} = NULL
      WHERE ${usageEvent.runId} IN (SELECT id FROM eligible_run)
        AND ${usageEvent.status} <> 'pending'
      RETURNING ${usageEvent.id}
    ), removed_runs AS (
      DELETE FROM ${agentRuns}
      WHERE ${agentRuns.id} IN (SELECT id FROM eligible_run)
        AND (SELECT ${count()} FROM removed_callbacks) +
          (SELECT ${count()} FROM detached_usage) >= 0
      RETURNING ${agentRuns.id} AS id,
        ${agentRuns.legacyConversationHistoryHash} AS hash
    ), held_blobs AS MATERIALIZED (
      SELECT ${blobs.hash} FROM ${blobs}
      INNER JOIN removed_runs ON removed_runs.hash = ${blobs.hash}
      ORDER BY ${blobs.hash} FOR UPDATE OF ${blobs} NOWAIT
    ), released_blobs AS (
      UPDATE ${blobs}
      SET ${sql.identifier(blobs.refCount.name)} = ${blobs.refCount} - 1
      FROM held_blobs
      WHERE ${blobs.hash} = held_blobs.hash AND ${blobs.refCount} >= 1
      RETURNING ${blobs.hash}
    )
    SELECT (SELECT ${count()} FROM removed_runs)::integer AS "deletedRuns",
      (SELECT ${count()} FROM released_blobs)::integer AS "releasedReferences",
      1 / CASE WHEN
        (SELECT ${count()} FROM removed_runs) = (SELECT ${count()} FROM eligible_run)
        AND (SELECT ${count()} FROM released_blobs) =
          (SELECT ${count()} FROM removed_runs WHERE hash IS NOT NULL)
      THEN 1 ELSE 0 END AS complete`;
}
