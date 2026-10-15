// Frozen deletion preparation from #39931 (fbeb04cd067359c20138eabd9010edbbb2ca1374).
// Physical table mappings preserve the exact outgoing SQL after runtime retirement.
import { eq, inArray, isNull, sql } from "drizzle-orm";
import { pgTable, QueryBuilder, uuid, varchar } from "drizzle-orm/pg-core";
import { z } from "zod";
import { agentRunColumns } from "../../src/columns/agent-run";

// Historical mappings belong to this preparation-only fixture, not the schema.
const agentRuns = pgTable("agent_runs", {
  ...agentRunColumns(),
  sessionId: uuid("session_id"),
});
const agentSessions = pgTable("agent_sessions", {
  id: uuid("id"),
  agentId: uuid("agent_id"),
});
const conversations = pgTable("conversations", {
  runId: uuid("run_id"),
  cliAgentSessionHistoryHash: varchar("cli_agent_session_history_hash", {
    length: 64,
  }),
});

/**
 * Dual membership for deletion admission, not permission or owner authority.
 * Session membership is removed by #37970 after Run backfill and API drain.
 */
export function agentRunDeletionMembership(agentIds: readonly string[]) {
  const ids = sql`ANY(${sql.param(agentIds)}::uuid[])`;
  const qb = new QueryBuilder();
  // UNION deduplicates membership and exposes both ownership indexes.
  const members = qb
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.agentId, ids))
    .union(
      qb
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .innerJoin(agentSessions, eq(agentRuns.sessionId, agentSessions.id))
        .where(eq(agentSessions.agentId, ids)),
    );
  return inArray(agentRuns.id, members);
}

export const deletedRunHistorySchema = z.object({
  id: z.uuid(),
  hash: z.string().nullable(),
  hadConversation: z.boolean(),
});

/**
 * Delete exactly the caller's admitted Run set and return its held references.
 * Run.framework marks the complete mirror written by #39772, including a NULL
 * hash. The mirror shares Conversation's retain; it does not own a second one.
 * Only pre-preparation rows read Conversation. Remove that branch after #37970
 * backfills historical Run facts and excludes pre-preparation writers/rollback.
 *
 * DELETE RETURNING observes the winning Run row after any writer wait. Reading
 * the hash before DELETE would release stale evidence. The existing Run cascade
 * removes Conversation; the caller releases these hashes in its transaction.
 */
export function deleteRunHistoriesSql(runIds: readonly string[]) {
  return sql`DELETE FROM ${agentRuns}
    WHERE ${eq(agentRuns.id, sql`ANY(${sql.param(runIds)}::uuid[])`)}
    RETURNING ${agentRuns.id} AS id,
      CASE WHEN ${isNull(agentRuns.framework)} THEN (
        SELECT ${conversations.cliAgentSessionHistoryHash} FROM ${conversations}
        WHERE ${eq(conversations.runId, agentRuns.id)}
      ) ELSE ${agentRuns.legacyConversationHistoryHash} END AS hash,
      EXISTS (
        SELECT 1 FROM ${conversations}
        WHERE ${eq(conversations.runId, agentRuns.id)}
      ) AS "hadConversation"`;
}
