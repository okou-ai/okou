import { userMessageDocumentSchema } from "@okouai/api-contracts/contracts/chat-threads";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { isNull, sql, type SQLWrapper } from "drizzle-orm";
import { z } from "zod";
import { visiblePiMemoryCitationText } from "@okouai/api-contracts/contracts/pi-memory-citations";
import { visibleChatEventRowContent } from "@okouai/api-contracts/contracts/retired-goal-archive";

import {
  nullableDriverValueDecoder,
  pgTextDecoder,
  zodDriverValueDecoder,
} from "../../lib/db-structured-result";

const chatEventUserMessageDecoder = zodDriverValueDecoder(
  userMessageDocumentSchema,
);
const requiredOfficialWorkflowIdsDecoder = zodDriverValueDecoder(
  z
    .array(z.string().uuid())
    .min(1)
    .refine((workflowIds) => {
      return new Set(workflowIds).size === workflowIds.length;
    }, "Official Workflow source IDs must be unique"),
);
const visibleChatEventTextDecoder = zodDriverValueDecoder(
  z.string().transform(visiblePiMemoryCitationText),
);

/** Canonical payload leaves projected from chat_events.payload. */
export function canonicalChatEventContent(
  payload: SQLWrapper = chatEvents.payload,
) {
  return sql`${payload}->>'content'`.mapWith(
    nullableDriverValueDecoder(visibleChatEventTextDecoder),
  );
}

const chatEventContentSourceDecoder = zodDriverValueDecoder(
  z
    .object({
      event_type: z.string(),
      run_id: z.string().nullable(),
      revokes_event_id: z.string().nullable(),
      context_type: z.string().nullable(),
      context_id: z.string().nullable(),
      run_event_sequence_number: z.number().nullable(),
      run_event_id: z.string().nullable(),
      payload: z.unknown(),
    })
    .transform((row) => {
      return visibleChatEventRowContent({
        eventType: row.event_type,
        runId: row.run_id,
        revokesEventId: row.revokes_event_id,
        contextType: row.context_type,
        contextId: row.context_id,
        runEventSequenceNumber: row.run_event_sequence_number,
        runEventId: row.run_event_id,
        payload: row.payload,
      });
    }),
);

/**
 * SELECT-only projection: carry raw provenance to the shared historical reader.
 * Predicates must keep canonicalChatEventContent's original text/null/regex SQL.
 */
export function canonicalChatEventVisibleContent() {
  return sql`CASE WHEN ${isNull(canonicalChatEventContent())} THEN NULL
    ELSE to_jsonb(${chatEvents}) END`.mapWith(
    nullableDriverValueDecoder(chatEventContentSourceDecoder),
  );
}

export function canonicalChatEventUserMessage(
  payload: SQLWrapper = chatEvents.payload,
) {
  return sql`${payload}->'userMessage'`.mapWith(
    nullableDriverValueDecoder(chatEventUserMessageDecoder),
  );
}

/** Validate the strict server-owned authority read from its private column. */
export function parseCanonicalChatEventRequiredOfficialWorkflowIds(
  workflowIds: readonly string[] | null,
): readonly string[] | null {
  return workflowIds === null
    ? null
    : requiredOfficialWorkflowIdsDecoder.mapFromDriverValue(workflowIds);
}

export function canonicalChatEventError(
  payload: SQLWrapper = chatEvents.payload,
) {
  return sql`${payload}->>'error'`.mapWith(
    nullableDriverValueDecoder(pgTextDecoder),
  );
}

/** Goal grouping exists only on the canonical goal context pointer. */
export function canonicalChatEventGoalId(
  contextType: SQLWrapper = chatEvents.contextType,
  contextId: SQLWrapper = chatEvents.contextId,
) {
  return sql`CASE
    WHEN ${contextType} = 'goal' THEN ${contextId}
    ELSE NULL
  END`.mapWith(nullableDriverValueDecoder(chatEvents.contextId));
}

/** Canonical payload leaves projected from an archived raw row. */
export function canonicalArchivedChatEventContent(
  row: ChatEventRow,
): string | null {
  return visibleChatEventRowContent(row);
}

export function canonicalArchivedChatEventUserMessage(row: ChatEventRow) {
  const userMessage = row.payload?.userMessage;
  return userMessage === undefined
    ? null
    : userMessageDocumentSchema.parse(userMessage);
}

export function canonicalArchivedChatEventError(
  row: ChatEventRow,
): string | null {
  return row.payload?.error ?? null;
}

export function canonicalArchivedChatEventGoalId(
  row: ChatEventRow,
): string | null {
  return row.contextType === "goal" ? row.contextId : null;
}
