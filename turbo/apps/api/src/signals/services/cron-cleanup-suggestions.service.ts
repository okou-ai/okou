import {
  suggestionStatus,
  liveSuggestion,
  retainedSuggestion,
} from "./agent-suggestions-lifecycle";
import { command } from "ccstate";
import { and, asc, eq, inArray, isNotNull, not, or, sql } from "drizzle-orm";
import { feedItems } from "@okouai/db/schema/feed-item";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";

const CLEANUP_BATCH_SIZE = 1000;
const MAX_BATCHES = 10;
export const cleanupSuggestions$ = command(
  async ({ set }, signal: AbortSignal) => {
    const db = set(writeDb$);
    const at = nowDate();
    const needsCompaction = and(
      isNotNull(feedItems.content),
      not(liveSuggestion(at)),
    );
    let cleaned = 0;
    let deleted = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      signal.throwIfAborted();
      const candidates = await db
        .select({
          orgId: feedItems.orgId,
          userId: feedItems.userId,
          id: feedItems.id,
        })
        .from(feedItems)
        .where(
          and(
            eq(feedItems.type, "suggestion"),
            or(not(retainedSuggestion(at)), needsCompaction),
          ),
        )
        .orderBy(
          asc(feedItems.expiresAt),
          asc(feedItems.orgId),
          asc(feedItems.userId),
          asc(feedItems.id),
        )
        .limit(CLEANUP_BATCH_SIZE);
      signal.throwIfAborted();
      if (!candidates.length) {
        break;
      }
      const selected = inArray(
        sql`(${feedItems.orgId}, ${feedItems.userId}, ${feedItems.id})`,
        candidates.map((row) => {
          return sql`(${row.orgId}, ${row.userId}, ${row.id}::uuid)`;
        }),
      );
      // Recheck current row state in each write so newly appended feedback survives.
      const removed = await db
        .delete(feedItems)
        .where(and(selected, not(retainedSuggestion(at))))
        .returning({ id: feedItems.id });
      signal.throwIfAborted();
      const compacted = await db
        .update(feedItems)
        .set({
          content: null,
          state: sql`jsonb_set(${feedItems.state}, '{status}', to_jsonb(CASE WHEN ${suggestionStatus} = 'active' THEN 'consumed' ELSE ${suggestionStatus} END))`,
        })
        .where(and(selected, retainedSuggestion(at), needsCompaction))
        .returning({ id: feedItems.id });
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
