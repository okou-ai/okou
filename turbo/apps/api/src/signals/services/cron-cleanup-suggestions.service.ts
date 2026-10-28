import { command } from "ccstate";
import { and, asc, inArray, isNotNull, not, or, sql } from "drizzle-orm";
import { agentSuggestions } from "@okouai/db/schema/agent-suggestion";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  liveSuggestion,
  retainedSuggestion,
} from "./agent-suggestions-lifecycle";

const CLEANUP_BATCH_SIZE = 1000;
const MAX_BATCHES = 10;
export const cleanupSuggestions$ = command(
  async ({ set }, signal: AbortSignal) => {
    const db = set(writeDb$);
    const at = nowDate();
    const needsCompaction = and(
      isNotNull(agentSuggestions.content),
      not(liveSuggestion(at)),
    );
    let cleaned = 0;
    let deleted = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      signal.throwIfAborted();
      const candidates = await db
        .select({
          orgId: agentSuggestions.orgId,
          userId: agentSuggestions.userId,
          id: agentSuggestions.id,
        })
        .from(agentSuggestions)
        .where(or(not(retainedSuggestion(at)), needsCompaction))
        .orderBy(
          asc(agentSuggestions.expiresAt),
          asc(agentSuggestions.orgId),
          asc(agentSuggestions.userId),
          asc(agentSuggestions.id),
        )
        .limit(CLEANUP_BATCH_SIZE);
      signal.throwIfAborted();
      if (!candidates.length) {
        break;
      }
      const selected = inArray(
        sql`(${agentSuggestions.orgId}, ${agentSuggestions.userId}, ${agentSuggestions.id})`,
        candidates.map((row) => {
          return sql`(${row.orgId}, ${row.userId}, ${row.id}::uuid)`;
        }),
      );
      // Recheck current row state in each write so newly appended feedback survives.
      const removed = await db
        .delete(agentSuggestions)
        .where(and(selected, not(retainedSuggestion(at))))
        .returning({ id: agentSuggestions.id });
      signal.throwIfAborted();
      const compacted = await db
        .update(agentSuggestions)
        .set({
          content: null,
          status: sql`CASE WHEN ${agentSuggestions.status} = 'active' THEN 'consumed' ELSE ${agentSuggestions.status} END`,
        })
        .where(and(selected, retainedSuggestion(at), needsCompaction))
        .returning({ id: agentSuggestions.id });
      signal.throwIfAborted();
      deleted += removed.length;
      cleaned += removed.length + compacted.length;
      if (candidates.length < CLEANUP_BATCH_SIZE) {
        break;
      }
    }
    return { cleaned, deleted };
  },
);
