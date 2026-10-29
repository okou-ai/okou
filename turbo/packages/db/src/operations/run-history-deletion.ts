import { count, eq, sql } from "drizzle-orm";
import { object, string, uuid } from "zod";
import { agentRuns } from "../runtime/agent-run";
import { usageEvent } from "../runtime/usage-event";
import { agentRunCallbacks } from "../schema/agent-run-callback";
import { runnerJobQueue } from "../schema/runner-job-queue";
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
