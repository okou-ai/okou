import { and, eq, gt, not, or, sql } from "drizzle-orm";
import { feedItems } from "@okouai/db/schema/feed-item";
import {
  suggestionSchema,
  suggestionReceiptSchema,
  suggestionStateSchema,
  SUGGESTION_RETENTION_MS,
  SUGGESTION_FEEDBACK_RETENTION_MS,
} from "@okouai/api-contracts/contracts/feed";
import {
  zodDriverValueDecoder,
  zodEnumDriverValueDecoder,
} from "../../lib/db-structured-result";

export const suggestionStatus = sql`${feedItems.state}->>'status'`.mapWith(
  zodEnumDriverValueDecoder(suggestionStateSchema.shape.status),
);
export const suggestionFeedbackEvents =
  sql`${feedItems.state}->'feedbacks'`.mapWith(
    zodDriverValueDecoder(suggestionStateSchema.shape.feedbacks),
  );

export function liveSuggestion(at: Date) {
  return sql`(${and(eq(feedItems.type, "suggestion"), eq(suggestionStatus, "active"), gt(feedItems.expiresAt, at))})`;
}
export function retainedSuggestionFeedback(at: Date) {
  const cutoff = new Date(at.getTime() - SUGGESTION_FEEDBACK_RETENTION_MS);
  return sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${suggestionFeedbackEvents}) AS feedback WHERE (feedback->>'createdAt')::timestamptz > ${cutoff.toISOString()}::timestamptz)`;
}
export function retainedSuggestion(at: Date) {
  const cutoff = new Date(at.getTime() - SUGGESTION_RETENTION_MS);
  return sql`(${or(liveSuggestion(at), and(not(eq(suggestionStatus, "active")), gt(feedItems.updatedAt, cutoff)), retainedSuggestionFeedback(at))})`;
}
export function suggestionRow(row: typeof feedItems.$inferSelect) {
  const value = {
    id: row.id,
    type: row.type,
    priority: row.priority,
    content: row.content,
    state: row.state,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
  return row.content === null
    ? suggestionReceiptSchema.parse(value)
    : suggestionSchema.parse(value);
}
