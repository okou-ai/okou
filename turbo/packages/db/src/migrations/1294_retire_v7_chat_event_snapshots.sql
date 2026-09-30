-- vm0:non-transactional
-- V8 pointers are already published for every thread. Keep the constraint
-- unvalidated while V7 rows are present; it blocks new V7 pointers immediately.
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
ALTER TABLE "chat_event_snapshots"
  DROP CONSTRAINT IF EXISTS "chat_event_snapshots_archive_schema_version_check",
  ADD CONSTRAINT "chat_event_snapshots_archive_schema_version_check"
    CHECK ("chat_event_snapshots"."archive_schema_version" = 8) NOT VALID,
  ALTER COLUMN "archive_schema_version" SET DEFAULT 8;
--> statement-breakpoint
-- Each procedure call commits one bounded primary-key range at a time.
SET statement_timeout = '60min';
--> statement-breakpoint
CREATE OR REPLACE PROCEDURE "retire_v7_chat_event_snapshot_pointers"()
LANGUAGE plpgsql
AS $$
DECLARE
  last_id uuid;
  next_id uuid;
BEGIN
  -- Fail closed if any V7-only thread remains; do not strand its only pointer.
  IF EXISTS (
    SELECT 1
    FROM "chat_event_snapshots" AS "v7"
    WHERE "v7"."archive_schema_version" = 7
      AND NOT EXISTS (
        SELECT 1
        FROM "chat_event_snapshots" AS "v8"
        WHERE "v8"."chat_thread_id" = "v7"."chat_thread_id"
          AND "v8"."archive_schema_version" = 8
      )
  ) THEN
    RAISE EXCEPTION
      'Cannot retire V7 Chat Event Snapshot pointers while a V7-only thread remains';
  END IF;

  LOOP
    SELECT "batch"."id" INTO next_id
    FROM (
      SELECT "id" FROM "chat_event_snapshots"
      WHERE last_id IS NULL OR "id" > last_id
      ORDER BY "id"
      LIMIT 5000
    ) AS "batch"
    ORDER BY "batch"."id" DESC
    LIMIT 1;
    EXIT WHEN next_id IS NULL;

    DELETE FROM "chat_event_snapshots"
    WHERE (last_id IS NULL OR "id" > last_id) AND "id" <= next_id
      AND "archive_schema_version" = 7;

    COMMIT;
    last_id := next_id;
  END LOOP;
END;
$$;
--> statement-breakpoint
CALL "retire_v7_chat_event_snapshot_pointers"();
--> statement-breakpoint
ALTER TABLE "chat_event_snapshots"
  VALIDATE CONSTRAINT "chat_event_snapshots_archive_schema_version_check";
--> statement-breakpoint
DROP PROCEDURE "retire_v7_chat_event_snapshot_pointers"();
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
RESET lock_timeout;
