import { command } from "ccstate";
import { and, asc, desc, eq, gt, ne, sql } from "drizzle-orm";
import { agentSuggestions } from "@okouai/db/schema/agent-suggestion";
import {
  SUGGESTION_RETENTION_MS,
  suggestionReceiptSchema,
  suggestionSchema,
} from "@okouai/api-contracts/contracts/suggestions";
import { pendingSuggestionFeedback as learningInputs } from "@okouai/api-contracts/contracts/suggestion-memory";
import { db$ } from "../external/db";
import { nowDate } from "../../lib/time";
import {
  liveSuggestion,
  pendingSuggestionFeedback,
  retainedSuggestion,
  suggestionRow,
} from "./agent-suggestions-lifecycle";
import { withSuggestionConsumeToken } from "./agent-suggestion-consumption-token";

interface Owner {
  readonly orgId: string;
  readonly userId: string;
}
export function suggestionOwner(owner: Owner) {
  return and(
    eq(agentSuggestions.orgId, owner.orgId),
    eq(agentSuggestions.userId, owner.userId),
  );
}
export const storedSuggestion$ = command(
  async ({ get }, owner: Owner, id: string, signal: AbortSignal) => {
    const [row] = await get(db$)
      .select()
      .from(agentSuggestions)
      .where(and(suggestionOwner(owner), eq(agentSuggestions.id, id)))
      .limit(1);
    signal.throwIfAborted();
    return row ? suggestionRow(row) : null;
  },
);
const recentSuggestionReceipts$ = command(
  async ({ get }, owner: Owner, signal: AbortSignal) => {
    const cutoff = new Date(nowDate().getTime() - SUGGESTION_RETENTION_MS);
    const rows = await get(db$)
      .select({
        id: agentSuggestions.id,
        status: agentSuggestions.status,
        selectedOptionId: agentSuggestions.selectedOptionId,
        feedbacks: agentSuggestions.feedbacks,
        createdAt: agentSuggestions.createdAt,
        updatedAt: agentSuggestions.updatedAt,
      })
      .from(agentSuggestions)
      .where(
        and(
          suggestionOwner(owner),
          ne(agentSuggestions.status, "active"),
          gt(agentSuggestions.updatedAt, cutoff),
        ),
      )
      .orderBy(
        sql`${desc(agentSuggestions.updatedAt)} NULLS LAST`,
        asc(agentSuggestions.id),
      )
      .limit(100);
    signal.throwIfAborted();
    return rows.map((row) => {
      return suggestionReceiptSchema.parse({
        ...row,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      });
    });
  },
);
export const readSuggestions$ = command(
  async ({ get, set }, owner: Owner, signal: AbortSignal) => {
    const rows = await get(db$)
      .select()
      .from(agentSuggestions)
      .where(and(suggestionOwner(owner), liveSuggestion(nowDate())))
      .orderBy(
        sql`${desc(agentSuggestions.priority)} NULLS LAST`,
        asc(agentSuggestions.createdAt),
        asc(agentSuggestions.id),
      )
      .limit(10);
    signal.throwIfAborted();
    const suggestions = rows.map((row) => {
      return withSuggestionConsumeToken(
        owner,
        suggestionSchema.parse(suggestionRow(row)),
      );
    });
    const receipts = await set(recentSuggestionReceipts$, owner, signal);
    return { status: 200 as const, body: { suggestions, receipts } };
  },
);
export const readSuggestionManagement$ = command(
  async (
    { get, set },
    owner: Owner,
    after: string | undefined,
    signal: AbortSignal,
  ) => {
    const rows = await get(db$)
      .select()
      .from(agentSuggestions)
      .where(
        and(
          suggestionOwner(owner),
          liveSuggestion(nowDate()),
          after ? gt(agentSuggestions.id, after) : undefined,
        ),
      )
      .orderBy(asc(agentSuggestions.id))
      .limit(101);
    signal.throwIfAborted();
    const page = rows.slice(0, 100);
    const suggestions = page.map((row) => {
      return withSuggestionConsumeToken(
        owner,
        suggestionSchema.parse(suggestionRow(row)),
      );
    });
    const receipts = after
      ? []
      : await set(recentSuggestionReceipts$, owner, signal);
    return {
      status: 200 as const,
      body: {
        suggestions,
        receipts,
        nextAfter: rows.length > 100 ? (page.at(-1)?.id ?? null) : null,
      },
    };
  },
);
export const pendingSuggestionInputs$ = command(
  async ({ get }, owner: Owner, signal: AbortSignal) => {
    const rows = await get(db$)
      .select({
        id: agentSuggestions.id,
        feedbacks: agentSuggestions.feedbacks,
      })
      .from(agentSuggestions)
      .where(
        and(
          suggestionOwner(owner),
          pendingSuggestionFeedback(),
          retainedSuggestion(nowDate()),
        ),
      )
      .orderBy(asc(agentSuggestions.updatedAt), asc(agentSuggestions.id))
      .limit(100);
    signal.throwIfAborted();
    return learningInputs(rows);
  },
);
