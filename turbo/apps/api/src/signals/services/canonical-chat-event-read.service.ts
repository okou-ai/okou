import { userMessageDocumentSchema } from "@okouai/api-contracts/validators/chat-threads";
import { chatInputModelSelectionSchema } from "@okouai/api-contracts/contracts/chat-input-model";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import { formatChatRunFailure } from "@okouai/api-contracts/contracts/errors";
import { knownRunFailureReasonSchema } from "@okouai/api-contracts/contracts/run-failure-reasons";
import { projectRunFailureRow } from "@okouai/api-contracts/contracts/chat-event-row-projection";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { sql, type SQLWrapper } from "drizzle-orm";
import { array, uuid } from "zod";

import {
  nullableDriverValueDecoder,
  pgTextDecoder,
  zodDriverValueDecoder,
} from "../../lib/db-structured-result";

const chatEventUserMessageDecoder = zodDriverValueDecoder(
  userMessageDocumentSchema,
);
const requiredOfficialWorkflowIdsDecoder = zodDriverValueDecoder(
  array(uuid())
    .min(1)
    .refine((workflowIds) => {
      return new Set(workflowIds).size === workflowIds.length;
    }, "Official Workflow source IDs must be unique"),
);

/** Canonical payload leaves projected from chat_events.payload. */
export function canonicalChatEventContent() {
  return canonicalChatEventText(sql`${chatEvents.payload}->>'content'`);
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

export function canonicalChatEventError() {
  return canonicalChatEventText(sql`${chatEvents.payload}->>'error'`);
}

function canonicalChatEventText(ordinaryText: SQLWrapper) {
  const reasons = knownRunFailureReasonSchema.options.map((failureReason) => {
    return sql`WHEN ${failureReason} THEN ${formatChatRunFailure(failureReason)}`;
  });
  return sql`CASE
    WHEN ${chatEvents.eventType} = 'run.failed' THEN
      CASE ${chatEvents.failureReason} ${sql.join(reasons, sql` `)}
        ELSE ${formatChatRunFailure(undefined)} END
    WHEN ${chatEvents.eventType} = 'run.cancelled' THEN 'Run cancelled'
    ELSE ${ordinaryText} END`.mapWith(
    nullableDriverValueDecoder(pgTextDecoder),
  );
}

/** Carry identity, rather than stored text, into contextual notification copy. */
export function canonicalChatEventRunFailureId() {
  return sql`CASE WHEN ${chatEvents.eventType} IN ('run.failed', 'run.cancelled')
    THEN ${chatEvents.runId} ELSE NULL END`.mapWith(
    nullableDriverValueDecoder(pgTextDecoder),
  );
}

/** Canonical payload leaves projected from an archived raw row. */
export function canonicalArchivedChatEventContent(
  row: ChatEventRow,
): string | null {
  return projectRunFailureRow(row).payload?.content ?? null;
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
  return projectRunFailureRow(row).payload?.error ?? null;
}

/** Private immutable model decision; NULL identifies an older queued input. */
export function canonicalChatInputModelSelection() {
  return sql`${chatEvents.modelSelection}`.mapWith(
    nullableDriverValueDecoder(
      zodDriverValueDecoder(chatInputModelSelectionSchema),
    ),
  );
}
