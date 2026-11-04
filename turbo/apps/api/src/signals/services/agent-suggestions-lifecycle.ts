import { and, eq, gt, not, or, sql } from "drizzle-orm";
import { agentSuggestions } from "@okouai/db/schema/agent-suggestion";
import {
  suggestionSchema,
  suggestionReceiptSchema,
  SUGGESTION_RETENTION_MS,
  SUGGESTION_FEEDBACK_RETENTION_MS,
  type Suggestion,
} from "@okouai/api-contracts/contracts/suggestions";

export function liveSuggestion(at: Date) {
  return sql`(${and(eq(agentSuggestions.status, "active"), gt(agentSuggestions.expiresAt, at))})`;
}
export function retainedSuggestionFeedback(at: Date) {
  const cutoff = new Date(at.getTime() - SUGGESTION_FEEDBACK_RETENTION_MS);
  return sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${agentSuggestions.feedbacks}) AS feedback WHERE (feedback->>'createdAt')::timestamptz > ${cutoff.toISOString()}::timestamptz)`;
}
export function retainedSuggestion(at: Date) {
  const cutoff = new Date(at.getTime() - SUGGESTION_RETENTION_MS);
  return sql`(${or(
    liveSuggestion(at),
    and(
      not(eq(agentSuggestions.status, "active")),
      gt(agentSuggestions.updatedAt, cutoff),
    ),
    retainedSuggestionFeedback(at),
  )})`;
}
export function suggestionRow(row: typeof agentSuggestions.$inferSelect) {
  const value = {
    ...row.content,
    id: row.id,
    status: row.status,
    priority: row.priority,
    selectedOptionId: row.selectedOptionId,
    feedbacks: row.feedbacks,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
  return row.content === null
    ? suggestionReceiptSchema.parse(value)
    : suggestionSchema.parse(value);
}
export function suggestionContent(
  item: Pick<
    Suggestion,
    "title" | "rationale" | "feedbackScope" | "options" | "customOption"
  >,
) {
  return {
    title: item.title,
    rationale: item.rationale,
    feedbackScope: item.feedbackScope,
    options: item.options,
    customOption: item.customOption,
  };
}
