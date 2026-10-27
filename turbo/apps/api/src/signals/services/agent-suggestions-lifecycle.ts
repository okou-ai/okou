import { gt, isNull, sql } from "drizzle-orm";
import { agentSuggestions } from "@okouai/db/schema/agent-suggestion";
import { SUGGESTION_RETENTION_MS } from "@okouai/api-contracts/contracts/suggestions";

/** Used against the current JSONB value so concurrent feedback is retained. */
export function retainedSuggestionEntry(at: Date) {
  const cutoff = new Date(at.getTime() - SUGGESTION_RETENTION_MS).toISOString();
  const timestamp = at.toISOString();
  return sql`CASE WHEN item->>'status' = 'active' THEN
    ${gt(sql`(item->>'createdAt')::timestamptz`, sql`${cutoff}::timestamptz`)}
    AND (${isNull(sql`item->>'expiresAt'`)} OR ${gt(sql`(item->>'expiresAt')::timestamptz`, sql`${timestamp}::timestamptz`)})
    ELSE ${gt(sql`(item->>'updatedAt')::timestamptz`, sql`${cutoff}::timestamptz`)} END`;
}

export function retainedSuggestionEntries(at: Date) {
  return sql`COALESCE((SELECT jsonb_agg(item) FROM jsonb_array_elements(${agentSuggestions.entries}) AS item WHERE ${retainedSuggestionEntry(at)}), '[]'::jsonb)`;
}
