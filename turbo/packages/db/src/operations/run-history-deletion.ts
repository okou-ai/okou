import { eq, sql } from "drizzle-orm";
import { object, string, uuid } from "zod";
import { agentRuns } from "../runtime/agent-run";
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
 */
export function deleteRunHistoriesSql(runIds: readonly string[]) {
  return sql`DELETE FROM ${agentRuns}
    WHERE ${eq(agentRuns.id, sql`ANY(${sql.param(runIds)}::uuid[])`)}
    RETURNING ${agentRuns.id} AS id,
      ${agentRuns.legacyConversationHistoryHash} AS hash`;
}
