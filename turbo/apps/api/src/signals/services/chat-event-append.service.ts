import { chatEvents } from "@okouai/db/schema/chat-event";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  executeRawRows,
  pgInt8ToSafeIntegerSchema,
  pgTimestampWithoutTimezoneToDateSchema,
} from "../../lib/db-raw-rows";
import type { ApiDb, Tx } from "../../lib/db-types";

export type ChatEventAppendConflict = "none" | "any" | "id" | "run-lifecycle";
export type PreparedChatEventRow = Omit<
  typeof chatEvents.$inferInsert,
  "seqId" | "contextType" | "id" | "createdAt"
> & {
  readonly id: string;
  readonly createdAt: Date;
  readonly contextType?: string | null;
};

const resultSchema = z.object({
  id: z.string().uuid(),
  createdAt: pgTimestampWithoutTimezoneToDateSchema,
  seqId: pgInt8ToSafeIntegerSchema,
  sequenceNumber: z.number().int().nullable(),
  allocationDurationMs: z.number(),
  insertDurationMs: z.number(),
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
 */
export async function appendCanonicalChatEvents(
  db: ApiDb | Tx,
  values: readonly PreparedChatEventRow[],
  conflict: ChatEventAppendConflict,
  splitWrites: boolean,
) {
  if (values.length === 0) {
    return [];
  }
  const input = JSON.stringify(
    values.map((value, ordinal) => {
      return {
        ...value,
        ordinal,
        createdAt: value.createdAt.toISOString(),
      };
    }),
  );
  const countsByThread = new Map<string, number>();
  for (const event of values) {
    countsByThread.set(
      event.chatThreadId,
      (countsByThread.get(event.chatThreadId) ?? 0) + 1,
    );
  }
  const orderedCounts = [...countsByThread].sort(([left], [right]) => {
    return left.localeCompare(right);
  });
  // A sorted locking SELECT before a multi-row UPDATE does not establish the
  // order in which its triggers reserve sequence rows. Chain single-thread CTEs
  // explicitly so legacy/direct batches share the same sequence lock order.
  const legacyReservations = splitWrites
    ? sql.empty()
    : sql.join(
        orderedCounts.map(([threadId, count], index) => {
          const predecessor =
            index === 0
              ? sql`EXISTS (SELECT 1 FROM append_started)`
              : sql`(SELECT count(*) FROM ${sql.identifier(`legacy_reservation_${index - 1}`)}) >= 0`;
          return sql`${sql.identifier(`legacy_reservation_${index}`)} AS (
      UPDATE chat_threads SET last_chat_event_seq_id = last_chat_event_seq_id + ${count}
      WHERE id = ${threadId}::uuid AND ${predecessor}
      RETURNING id AS chat_thread_id, last_chat_event_seq_id AS last_seq_id
    ),`;
        }),
        sql` `,
      );
  // The legacy column appears only inside this inactive-after-activation branch.
  const reserve = splitWrites
    ? sql`
        INSERT INTO chat_event_sequences (chat_thread_id, last_seq_id)
        SELECT counts.chat_thread_id, counts.event_count
        FROM counts CROSS JOIN append_started
        ORDER BY counts.chat_thread_id
        ON CONFLICT (chat_thread_id) DO UPDATE
          SET last_seq_id = chat_event_sequences.last_seq_id + EXCLUDED.last_seq_id
        RETURNING chat_thread_id, last_seq_id`
    : sql.join(
        orderedCounts.map((_, index) => {
          return sql`SELECT chat_thread_id, last_seq_id FROM ${sql.identifier(`legacy_reservation_${index}`)}`;
        }),
        sql` UNION ALL `,
      );
  const rows = await executeRawRows(
    db,
    sql`
    WITH input AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${input}::jsonb) AS event(
        id uuid, "chatThreadId" uuid, "runId" uuid, "revokesEventId" uuid,
        "eventType" text, payload jsonb, "failureReason" text,
        "requiredOfficialWorkflowIds" uuid[], "contextType" text, "contextId" uuid,
        "runEventSequenceNumber" integer, "runEventId" text,
        "createdAt" timestamp, ordinal integer
      )
    ), counts AS MATERIALIZED (
      SELECT "chatThreadId" AS chat_thread_id, count(*) AS event_count
      FROM input GROUP BY "chatThreadId"
    ), append_started AS MATERIALIZED (
      SELECT clock_timestamp() AS started_at
    ), ${legacyReservations}
    reserved AS (${reserve}), allocation_finished AS MATERIALIZED (
      SELECT clock_timestamp() AS finished_at FROM (SELECT count(*) FROM reserved) AS completed
    ), inserted AS (
      INSERT INTO chat_events (
        id, chat_thread_id, run_id, revokes_event_id, event_type, payload,
        failure_reason, required_official_workflow_ids, context_type, context_id,
        run_event_sequence_number, run_event_id, seq_id, created_at
      )
      SELECT input.id, input."chatThreadId", input."runId", input."revokesEventId",
        input."eventType", input.payload, input."failureReason",
        input."requiredOfficialWorkflowIds", input."contextType", input."contextId",
        input."runEventSequenceNumber", input."runEventId",
        reserved.last_seq_id - counts.event_count + row_number() OVER (
          PARTITION BY input."chatThreadId" ORDER BY input.ordinal
        ), input."createdAt"
      FROM input
      JOIN counts ON counts.chat_thread_id = input."chatThreadId"
      LEFT JOIN reserved ON reserved.chat_thread_id = input."chatThreadId"
      CROSS JOIN allocation_finished
      ORDER BY input.ordinal
      ${conflictClause(conflict)}
      RETURNING id, created_at, seq_id, run_event_sequence_number
    )
    SELECT inserted.id, inserted.created_at::text AS "createdAt",
      inserted.seq_id AS "seqId", inserted.run_event_sequence_number AS "sequenceNumber",
      (EXTRACT(epoch FROM allocation_finished.finished_at - append_started.started_at) * 1000)::float8 AS "allocationDurationMs",
      (EXTRACT(epoch FROM clock_timestamp() - allocation_finished.finished_at) * 1000)::float8 AS "insertDurationMs"
    FROM inserted CROSS JOIN allocation_finished CROSS JOIN append_started
  `,
    resultSchema,
  );
  return rows;
}
