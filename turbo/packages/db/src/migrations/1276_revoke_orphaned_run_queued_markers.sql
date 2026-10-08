-- Interrupting a run while it was still queued cancelled the run without
-- appending the run.dequeued revocation for its run.queued marker, so those
-- markers never closed. The run queue is retired and nothing writes run.queued
-- anymore; close every remaining marker with the same shape the queue used
-- (payload-free, run_event_id 'queue:dequeued', target context copied).
-- Sequence allocation mirrors appendCanonicalChatEvents. The NOT EXISTS guard
-- makes a replay insert nothing.
-- run.queued has no event_type index, so the marker lookup scans chat_events.
SET LOCAL statement_timeout = '60s';
--> statement-breakpoint
WITH "open_markers" AS MATERIALIZED (
  SELECT
    "marker"."id",
    "marker"."chat_thread_id",
    "marker"."run_id",
    "marker"."context_type",
    "marker"."context_id",
    GREATEST(
      now() AT TIME ZONE 'UTC',
      "marker"."created_at" + interval '1 millisecond'
    ) AS "created_at"
  FROM "chat_events" AS "marker"
  WHERE "marker"."event_type" = 'run.queued'
    AND NOT EXISTS (
      SELECT 1
      FROM "chat_events" AS "revoker"
      WHERE "revoker"."revokes_event_id" = "marker"."id"
    )
), "counts" AS MATERIALIZED (
  SELECT "chat_thread_id", count(*) AS "event_count"
  FROM "open_markers"
  GROUP BY "chat_thread_id"
), "reserved" AS (
  INSERT INTO "chat_event_sequences" ("chat_thread_id", "last_seq_id")
  SELECT "chat_thread_id", "event_count"
  FROM "counts"
  ORDER BY "chat_thread_id"
  ON CONFLICT ("chat_thread_id") DO UPDATE
    SET "last_seq_id" = "chat_event_sequences"."last_seq_id" + EXCLUDED."last_seq_id"
  RETURNING "chat_thread_id", "last_seq_id"
)
INSERT INTO "chat_events" (
  "id", "chat_thread_id", "run_id", "revokes_event_id", "event_type",
  "payload", "context_type", "context_id", "run_event_id", "seq_id",
  "created_at"
)
SELECT
  gen_random_uuid(),
  "open_markers"."chat_thread_id",
  "open_markers"."run_id",
  "open_markers"."id",
  'run.dequeued',
  NULL,
  "open_markers"."context_type",
  "open_markers"."context_id",
  'queue:dequeued',
  "reserved"."last_seq_id" - "counts"."event_count" + row_number() OVER (
    PARTITION BY "open_markers"."chat_thread_id" ORDER BY "open_markers"."id"
  ),
  "open_markers"."created_at"
FROM "open_markers"
JOIN "counts" ON "counts"."chat_thread_id" = "open_markers"."chat_thread_id"
JOIN "reserved" ON "reserved"."chat_thread_id" = "open_markers"."chat_thread_id";
