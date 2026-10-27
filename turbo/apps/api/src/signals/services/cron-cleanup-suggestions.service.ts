import { command } from "ccstate";
import { and, asc, eq, exists, inArray, not, or, sql } from "drizzle-orm";
import { agentSuggestions } from "@okouai/db/schema/agent-suggestion";

import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  retainedSuggestionEntries,
  retainedSuggestionEntry,
} from "./agent-suggestions-lifecycle";

const CLEANUP_BATCH_SIZE = 1000;
const MAX_BATCHES = 10;

export const cleanupSuggestions$ = command(
  async ({ set }, signal: AbortSignal) => {
    const db = set(writeDb$);
    const at = nowDate();
    const needsCleanup = or(
      eq(agentSuggestions.entries, sql`'[]'::jsonb`),
      exists(
        sql`(SELECT 1 FROM jsonb_array_elements(${agentSuggestions.entries}) AS item WHERE ${not(retainedSuggestionEntry(at))})`,
      ),
    );
    let cleaned = 0;
    let deleted = 0;

    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      signal.throwIfAborted();
      const candidates = db
        .select({
          orgId: agentSuggestions.orgId,
          userId: agentSuggestions.userId,
        })
        .from(agentSuggestions)
        .where(needsCleanup)
        .orderBy(asc(agentSuggestions.orgId), asc(agentSuggestions.userId))
        .limit(CLEANUP_BATCH_SIZE);
      // Both the predicate and replacement use the row's current value after
      // any concurrent write. Never overwrite newly consumed feedback with a
      // collection read before its transition.
      const rows = await db
        .update(agentSuggestions)
        .set({ entries: retainedSuggestionEntries(at) })
        .where(
          and(
            needsCleanup,
            inArray(
              sql`(${agentSuggestions.orgId}, ${agentSuggestions.userId})`,
              candidates,
            ),
          ),
        )
        .returning({
          orgId: agentSuggestions.orgId,
          userId: agentSuggestions.userId,
        });
      signal.throwIfAborted();
      cleaned += rows.length;
      if (rows.length === 0) {
        break;
      }

      const empty = await db.delete(agentSuggestions).where(
        and(
          eq(agentSuggestions.entries, sql`'[]'::jsonb`),
          inArray(
            sql`(${agentSuggestions.orgId}, ${agentSuggestions.userId})`,
            rows.map((owner) => {
              return sql`(${owner.orgId}, ${owner.userId})`;
            }),
          ),
        ),
      );
      signal.throwIfAborted();
      deleted += empty.rowCount ?? 0;
      if (rows.length < CLEANUP_BATCH_SIZE) {
        break;
      }
    }

    return { cleaned, deleted };
  },
);
