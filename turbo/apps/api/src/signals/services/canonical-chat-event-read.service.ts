import { chatInputModelSelectionSchema } from "@okouai/api-contracts/contracts/chat-input-model";
import { userMessageDocumentSchema } from "@okouai/api-contracts/contracts/chat-threads";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { sql, type SQLWrapper } from "drizzle-orm";
import { z } from "zod";
import { visiblePiMemoryCitationText } from "@okouai/api-contracts/contracts/pi-memory-citations";

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

/** Canonical payload leaves projected from an archived raw row. */
export function canonicalArchivedChatEventContent(
  row: ChatEventRow,
): string | null {
  const content = row.payload?.content;
  return content === undefined ? null : visiblePiMemoryCitationText(content);
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

/** Private immutable model decision; NULL identifies an older queued input. */
export function canonicalChatInputModelSelection() {
  return sql`${chatEvents.modelSelection}`.mapWith(
    nullableDriverValueDecoder(
      zodDriverValueDecoder(chatInputModelSelectionSchema),
    ),
  );
}
