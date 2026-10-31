import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatRelations } from "@okouai/db/schema/chat-relation";
import { sql, type SQL } from "drizzle-orm";
import { number, object, uuid } from "zod";
import {
  pgInt8ToSafeIntegerSchema,
  pgTimestampWithoutTimezoneToDateSchema,
} from "../../lib/db-raw-rows";

export type ChatEventAppendConflict = "none" | "any" | "id" | "run-lifecycle";
export interface ChatEventRelationSource {
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly createsThread: boolean;
}
export type PreparedChatEventRow = Omit<
  typeof chatEvents.$inferInsert,
  "seqId" | "contextType" | "id" | "createdAt"
> & {
  readonly id: string;
  readonly createdAt: Date;
  readonly contextType?: string | null;
};

export const chatEventAppendResultSchema = object({
  id: uuid(),
  createdAt: pgTimestampWithoutTimezoneToDateSchema,
  seqId: pgInt8ToSafeIntegerSchema,
  sequenceNumber: number().int().nullable(),
});

/** Preserve the single-event command result without leaking batch-only fields. */
export const chatEventCommandResultSchema =
  chatEventAppendResultSchema.transform(({ id, createdAt, seqId }) => {
    return { id, createdAt, seqId };
  });

function conflictClause(conflict: ChatEventAppendConflict): SQL {
  if (conflict === "any") {
    return sql`ON CONFLICT DO NOTHING`;
  }
  if (conflict === "id") {
    return sql`ON CONFLICT (id) DO NOTHING`;
  }
  if (conflict === "run-lifecycle") {
    return sql`ON CONFLICT (run_id) WHERE event_type IN ('run.completed', 'run.failed', 'run.cancelled') DO NOTHING`;
  }
  return sql.empty();
}

/**
 * One SQL statement owns allocation and insertion, including cross-thread batches.
 * Sorted reservations establish a common lock order. Intentional conflicts consume
 * positions; a SQL error rolls allocation back together with the insert.
 * An optional input predicate runs before counts or reservations are produced.
 * A single-thread conditional writer may supply its observed sequence watermark;
 * it must gate insertion on the returned reservation to yield to newer inputs.
 */
export function canonicalChatEventInputCtes(
  values: readonly PreparedChatEventRow[],
  inputEligibility?: SQL,
  expectedLastSeqId?: number,
): SQL {
  const input = JSON.stringify(
    values.map((value, ordinal) => {
      return {
        ...value,
        ordinal,
        createdAt: value.createdAt.toISOString(),
      };
    }),
  );
  return sql`
    input AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${input}::jsonb) AS event(
        id uuid, "chatThreadId" uuid, "runId" uuid, "revokesEventId" uuid,
        "eventType" text, payload jsonb, "modelSelection" jsonb, "failureReason" text,
        "requiredOfficialWorkflowIds" uuid[], "contextType" text, "contextId" uuid,
        "runEventSequenceNumber" integer, "runEventId" text,
        "createdAt" timestamp, ordinal integer
      )${inputEligibility ? sql` WHERE ${inputEligibility}` : sql.empty()}
    ), counts AS MATERIALIZED (
      SELECT "chatThreadId" AS chat_thread_id, count(*) AS event_count
      FROM input GROUP BY "chatThreadId"
    ), reserved AS (${
      expectedLastSeqId === undefined
        ? sql`
      INSERT INTO chat_event_sequences (chat_thread_id, last_seq_id)
      SELECT counts.chat_thread_id, counts.event_count
      FROM counts
      ORDER BY counts.chat_thread_id
      ON CONFLICT (chat_thread_id) DO UPDATE
        SET last_seq_id = chat_event_sequences.last_seq_id + EXCLUDED.last_seq_id
      RETURNING chat_thread_id, last_seq_id
    `
        : sql`
      UPDATE chat_event_sequences AS sequence
      SET last_seq_id = sequence.last_seq_id + counts.event_count
      FROM counts
      WHERE sequence.chat_thread_id = counts.chat_thread_id
        AND sequence.last_seq_id = ${expectedLastSeqId}
      RETURNING sequence.chat_thread_id, sequence.last_seq_id
    `
    }
    )
  `;
}

/** Pure INSERT for rows prepared and reserved by canonicalChatEventInputCtes. */
export function canonicalChatEventInsertSql(
  conflict: ChatEventAppendConflict,
  source?: {
    readonly eligibility?: SQL;
    readonly sequenceOffset?: SQL;
    readonly threadIdentity?: SQL;
  },
): SQL {
  const sequenceOffset =
    source?.sequenceOffset ??
    sql`row_number() OVER (
    PARTITION BY input."chatThreadId" ORDER BY input.ordinal
  )`;
  const threadIdentity = source?.threadIdentity ?? sql`input."chatThreadId"`;
  return sql`
      INSERT INTO chat_events (
        id, chat_thread_id, run_id, revokes_event_id, event_type, payload, model_selection,
        failure_reason, required_official_workflow_ids, context_type, context_id,
        run_event_sequence_number, run_event_id, seq_id, created_at
      )
      SELECT input.id, ${threadIdentity}, input."runId", input."revokesEventId",
        input."eventType", input.payload, input."modelSelection", input."failureReason",
        input."requiredOfficialWorkflowIds", input."contextType", input."contextId",
        input."runEventSequenceNumber", input."runEventId",
        reserved.last_seq_id - counts.event_count + ${sequenceOffset}, input."createdAt"
      FROM input
      JOIN counts ON counts.chat_thread_id = input."chatThreadId"
      LEFT JOIN reserved ON reserved.chat_thread_id = input."chatThreadId"
      ${source?.eligibility ? sql`WHERE ${source.eligibility}` : sql.empty()}
      ORDER BY input.ordinal
      ${conflictClause(conflict)}
      RETURNING id, created_at, seq_id, run_event_sequence_number`;
}

/** Atomic default append; compound owners reuse its same reservation/INSERT. */
export function canonicalChatEventAppendCtes(
  values: readonly PreparedChatEventRow[],
  conflict: ChatEventAppendConflict,
  inputEligibility?: SQL,
): SQL {
  // Attribute only winning input replacements, both at admission and active delivery.
  const consumesInput = values.some((value) => {
    return (
      value.eventType === "input.prompt" &&
      typeof value.runId === "string" &&
      typeof value.revokesEventId === "string"
    );
  });
  const relationAttribution = consumesInput
    ? sql`, attributed_relations AS (
    UPDATE chat_relations AS relation SET target_run_id = input."runId"
    FROM input JOIN inserted ON inserted.id = input.id
    WHERE relation.message_event_id = input."revokesEventId"
      AND relation.target_chat_thread_id = input."chatThreadId"
      AND relation.type = 'message' AND relation.target_run_id IS NULL
      AND input."eventType" = 'input.prompt' AND input."runId" IS NOT NULL
  )`
    : sql.empty();
  return sql`
    ${canonicalChatEventInputCtes(values, inputEligibility)},
    inserted AS (${canonicalChatEventInsertSql(conflict)})
    ${relationAttribution}
  `;
}

/** Standalone append; compound writers reuse the same allocation and insertion. */
export function appendCanonicalChatEventsSql(
  values: readonly PreparedChatEventRow[],
  conflict: ChatEventAppendConflict,
  inputEligibility?: SQL,
  relationSource?: ChatEventRelationSource,
): SQL {
  // A replay or losing replacement returns no inserted input, so it owns no
  // relation. The relation is visible as soon as another run can consume it.
  const relations = relationSource
    ? sql`, recorded_relations AS (
      INSERT INTO ${chatRelations} (
        org_id, user_id, type, source_chat_thread_id, target_chat_thread_id,
        source_run_id, message_event_id, created_at
      )
      SELECT ${relationSource.orgId}, ${relationSource.userId}, action.type,
        ${relationSource.threadId}, input."chatThreadId", ${relationSource.runId},
        CASE WHEN action.type = 'message' THEN inserted.id ELSE NULL END,
        inserted.created_at
      FROM input JOIN inserted ON inserted.id = input.id
      CROSS JOIN (VALUES ('message'), ('created')) AS action(type)
      WHERE input."chatThreadId" <> ${relationSource.threadId}::uuid
        AND (action.type = 'message' OR ${relationSource.createsThread})
    )`
    : sql.empty();
  return sql`
    WITH ${canonicalChatEventAppendCtes(values, conflict, inputEligibility)}
    ${relations}
    SELECT inserted.id, inserted.created_at::text AS "createdAt",
      inserted.seq_id AS "seqId", inserted.run_event_sequence_number AS "sequenceNumber"
    FROM inserted
  `;
}
