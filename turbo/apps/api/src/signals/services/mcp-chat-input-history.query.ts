import { chatEventRowSchema } from "@okouai/api-contracts/contracts/chat-event-rows";
import type { McpGetChatInputInput } from "@okouai/api-contracts/contracts/mcp-chat-input";
import { agents } from "@okouai/db/schema/agent";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatEventSnapshots } from "@okouai/db/schema/chat-event-snapshot";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { and, eq, exists, lte, not, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { pgInt8ToSafeIntegerSchema } from "../../lib/db-raw-rows";
import { chatEventHistoryBytes } from "./mcp-chat-message-history.service";

const originEvent = alias(chatEvents, "origin_event");
const predecessorEvent = alias(chatEvents, "predecessor_event");
const successorEvent = alias(chatEvents, "successor_event");
const inputFact = alias(chatEvents, "input_fact");
const sizeShape = Object.freeze({
  bytes: pgInt8ToSafeIntegerSchema,
  rows: pgInt8ToSafeIntegerSchema,
});
export const inputHistoryQueryRowSchema = z.discriminatedUnion("kind", [
  z.object({
    ...sizeShape,
    kind: z.literal("selected"),
    events: z.array(chatEventRowSchema),
  }),
  z.object({
    ...sizeShape,
    kind: z.enum([
      "not_found",
      "canonical",
      "history_limit",
      "history_unavailable",
    ]),
    events: z.null(),
  }),
]);

/** Metadata stays finite; payloads are read only after complete preflight. */
export function unarchivedInputHistoryQuery(
  principal: { readonly userId: string; readonly orgId: string },
  input: McpGetChatInputInput,
  remaining: { readonly bytes: number; readonly rows: number },
) {
  return sql`
    WITH RECURSIVE owned AS MATERIALIZED (
      SELECT ${chatThreads.id} AS id
      FROM ${chatThreads}
      INNER JOIN ${agents} ON ${eq(agents.id, chatThreads.agentId)}
      WHERE ${and(
        eq(chatThreads.id, input.threadId),
        eq(chatThreads.userId, principal.userId),
        eq(agents.orgId, principal.orgId),
      )}
    ), archive AS MATERIALIZED (
      SELECT 1 FROM ${chatEventSnapshots}
      INNER JOIN owned ON ${eq(chatEventSnapshots.chatThreadId, sql`owned.id`)}
      LIMIT 1
    ), origin AS MATERIALIZED (
      SELECT ${originEvent.id} AS id,
        ${originEvent.revokesEventId} AS revokes_event_id,
        ${originEvent.seqId} AS seq_id,
        ${chatEventHistoryBytes(originEvent)} AS bytes
      FROM ${chatEvents} AS origin_event
      INNER JOIN owned ON ${eq(originEvent.chatThreadId, sql`owned.id`)}
      WHERE ${and(
        eq(originEvent.id, input.eventId),
        notExists(sql`(SELECT 1 FROM archive)`),
      )}
    ), predecessor AS MATERIALIZED (
      SELECT ${predecessorEvent.id} AS id,
        ${chatEventHistoryBytes(predecessorEvent)} AS bytes
      FROM ${chatEvents} AS predecessor_event
      INNER JOIN origin ON ${eq(predecessorEvent.id, sql`origin.revokes_event_id`)}
      WHERE ${eq(predecessorEvent.chatThreadId, input.threadId)}
    ), chain AS (
      SELECT origin.id, origin.seq_id,
        origin.bytes + COALESCE(predecessor.bytes, 0) AS total_bytes,
        1 + CASE WHEN predecessor.id IS NULL THEN 0 ELSE 1 END AS row_count,
        (origin.revokes_event_id IS NOT NULL AND predecessor.id IS NULL) AS invalid
      FROM origin LEFT JOIN predecessor ON true
      UNION ALL
      SELECT ${successorEvent.id}, ${successorEvent.seqId},
        chain.total_bytes + ${chatEventHistoryBytes(successorEvent)},
        chain.row_count + 1,
        ${or(
          lte(successorEvent.seqId, sql`chain.seq_id`),
          exists(sql`(SELECT 1 FROM predecessor
            WHERE ${eq(successorEvent.id, sql`predecessor.id`)})`),
        )}
      FROM chain
      INNER JOIN ${chatEvents} AS successor_event
        ON ${and(
          eq(successorEvent.chatThreadId, input.threadId),
          eq(successorEvent.revokesEventId, sql`chain.id`),
        )}
      WHERE ${and(
        not(sql`chain.invalid`),
        lte(sql`chain.row_count`, remaining.rows),
        lte(sql`chain.total_bytes`, remaining.bytes),
      )}
    ), totals AS MATERIALIZED (
      SELECT total_bytes, row_count, invalid FROM chain
      ORDER BY row_count DESC LIMIT 1
    ), decision AS MATERIALIZED (
      SELECT CASE
        WHEN NOT EXISTS (SELECT 1 FROM owned) THEN 'not_found'
        WHEN EXISTS (SELECT 1 FROM archive)
          OR NOT EXISTS (SELECT 1 FROM origin) THEN 'canonical'
        WHEN totals.total_bytes > ${remaining.bytes}
          OR totals.row_count > ${remaining.rows} THEN 'history_limit'
        WHEN totals.invalid THEN 'history_unavailable'
        ELSE 'selected'
      END AS kind,
        COALESCE(totals.total_bytes, 0)::text AS bytes,
        COALESCE(totals.row_count, 0)::text AS rows
      FROM (SELECT 1) AS singleton LEFT JOIN totals ON true
    ), selected_ids AS (
      SELECT id FROM chain UNION SELECT id FROM predecessor
    )
    SELECT decision.kind, decision.bytes, decision.rows,
      CASE WHEN decision.kind = 'selected' THEN (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', ${inputFact.id},
            'chatThreadId', ${inputFact.chatThreadId},
            'runId', ${inputFact.runId},
            'revokesEventId', ${inputFact.revokesEventId},
            'eventType', ${inputFact.eventType},
            'payload', ${inputFact.payload},
            'contextType', ${inputFact.contextType},
            'contextId', ${inputFact.contextId},
            'runEventSequenceNumber', ${inputFact.runEventSequenceNumber},
            'runEventId', ${inputFact.runEventId},
            'seqId', ${inputFact.seqId},
            'createdAt', to_char(${inputFact.createdAt}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          ) || CASE WHEN ${inputFact.failureReason} IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('failureReason', ${inputFact.failureReason}) END
          ORDER BY ${inputFact.seqId}
        )
        FROM ${chatEvents} AS input_fact
        INNER JOIN selected_ids ON ${eq(inputFact.id, sql`selected_ids.id`)}
        WHERE ${eq(inputFact.chatThreadId, input.threadId)}
      ) ELSE NULL END AS events
    FROM decision
  `;
}
