-- vm0:non-transactional
-- Chat Event V8. Deletes the eight retired event types, rewrites historical
-- Goal and GitHub contexts, converts stored Goal userMessage parts to text,
-- retires the `goal` run source and drops `runGroupIndex` from saved shares.
-- Snapshot objects are upgraded by the API with the same rules.
--
-- The migration is re-runnable: every rewrite selects only rows that still
-- carry a retired value, and the constraint swap drops by name before adding.
-- The new checks are added NOT VALID first, so writes are held to V8 while the
-- committed batches below converge existing rows; VALIDATE then scans them.
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
ALTER TABLE "chat_events"
  DROP CONSTRAINT IF EXISTS "chat_events_goal_open_payload_check",
  DROP CONSTRAINT IF EXISTS "chat_events_goal_close_payload_check",
  DROP CONSTRAINT IF EXISTS "chat_events_goal_marker_payload_check",
  DROP CONSTRAINT IF EXISTS "chat_events_event_type_check",
  DROP CONSTRAINT IF EXISTS "chat_events_context_type_check",
  DROP CONSTRAINT IF EXISTS "chat_events_input_context_type_check",
  ADD CONSTRAINT "chat_events_event_type_check" CHECK ("chat_events"."event_type" IN (
    'input.prompt',
    'input.automation',
    'input.budget',
    'input.rejected',
    'output.message',
    'output.error',
    'output.followups',
    'run.completed',
    'run.failed',
    'run.cancelled',
    'control.interrupt',
    'control.revoke',
    'usage.recorded'
  )) NOT VALID,
  ADD CONSTRAINT "chat_events_context_type_check" CHECK ("chat_events"."context_type" IN (
    'web',
    'slack',
    'discord',
    'feishu',
    'teams',
    'telegram',
    'agentphone',
    'automation',
    'agent_run'
  )) NOT VALID,
  ADD CONSTRAINT "chat_events_input_context_type_check" CHECK (
    "chat_events"."event_type" NOT IN ('input.prompt', 'input.automation', 'input.budget', 'input.rejected')
    OR "chat_events"."context_type" IS NOT NULL
  ) NOT VALID;
--> statement-breakpoint
-- V8 snapshot pointers are published beside the V7 pointer of the same thread.
-- V7 pointers remain valid until snapshots converge and the V7 API leaves the
-- rollback window; the V8 plan's PR-3 then restores a single-version check.
ALTER TABLE "chat_event_snapshots"
  DROP CONSTRAINT IF EXISTS "chat_event_snapshots_archive_schema_version_check",
  ADD CONSTRAINT "chat_event_snapshots_archive_schema_version_check"
    CHECK ("chat_event_snapshots"."archive_schema_version" IN (7, 8)) NOT VALID,
  ALTER COLUMN "archive_schema_version" SET DEFAULT 8;
--> statement-breakpoint
-- Each procedure commits one bounded batch at a time; the CALLs cover full scans.
SET statement_timeout = '60min';
--> statement-breakpoint
-- Replaces every {type:"goal", goalBrief} part of a userMessage document with
-- {type:"text", text: goalBrief}, preserving part order. Other documents are
-- returned unchanged.
CREATE OR REPLACE FUNCTION "chat_event_v8_goal_parts_to_text"("document" jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN jsonb_typeof("document" -> 'parts') = 'array'
      AND "document" -> 'parts' @> '[{"type":"goal"}]'
    THEN jsonb_set(
      "document",
      '{parts}',
      (
        SELECT jsonb_agg(
          CASE
            WHEN "part" ->> 'type' = 'goal'
            THEN jsonb_build_object('type', 'text', 'text', "part" -> 'goalBrief')
            ELSE "part"
          END
          ORDER BY "position"
        )
        FROM jsonb_array_elements("document" -> 'parts')
          WITH ORDINALITY AS "parts"("part", "position")
      )
    )
    ELSE "document"
  END
$$;
--> statement-breakpoint
-- chat_events has no index on event_type or context_type, so walk the primary
-- key once in bounded id ranges instead of rescanning the table per batch.
CREATE OR REPLACE PROCEDURE "chat_event_v8_rewrite_chat_events"()
LANGUAGE plpgsql
AS $$
DECLARE
  last_id uuid := '00000000-0000-0000-0000-000000000000';
  next_id uuid;
BEGIN
  LOOP
    SELECT "batch"."id" INTO next_id
    FROM (
      SELECT "id" FROM "chat_events"
      WHERE "id" > last_id
      ORDER BY "id"
      LIMIT 5000
    ) AS "batch"
    ORDER BY "batch"."id" DESC
    LIMIT 1;
    EXIT WHEN next_id IS NULL;

    -- Revocation edges that point at a deleted row may dangle; readers treat
    -- revocations only as a set of IDs.
    DELETE FROM "chat_events"
    WHERE "id" > last_id AND "id" <= next_id
      AND "event_type" IN (
        'input.goal',
        'goal.open',
        'goal.close',
        'run.queued',
        'run.dequeued',
        'output.thinking',
        'browser.open',
        'browser.close'
      );

    -- Goal inputs (input.* and control.revoke) become automation inputs
    -- without a context row, other Goal rows lose the context like ordinary
    -- output, and GitHub rows become web rows.
    UPDATE "chat_events"
    SET
      "context_type" = CASE
        WHEN "context_type" = 'github' THEN 'web'
        WHEN "context_type" = 'goal'
          AND ("event_type" LIKE 'input.%' OR "event_type" = 'control.revoke')
        THEN 'automation'
        WHEN "context_type" = 'goal' THEN NULL
        ELSE "context_type"
      END,
      "context_id" = CASE
        WHEN "context_type" IN ('goal', 'github') THEN NULL
        ELSE "context_id"
      END,
      "payload" = CASE
        WHEN "payload" -> 'userMessage' -> 'parts' @> '[{"type":"goal"}]'
        THEN jsonb_set(
          "payload",
          '{userMessage}',
          "chat_event_v8_goal_parts_to_text"("payload" -> 'userMessage')
        )
        ELSE "payload"
      END
    WHERE "id" > last_id AND "id" <= next_id
      AND (
        "context_type" IN ('goal', 'github')
        OR "payload" -> 'userMessage' -> 'parts' @> '[{"type":"goal"}]'
      );

    COMMIT;
    last_id := next_id;
  END LOOP;
END;
$$;
--> statement-breakpoint
CALL "chat_event_v8_rewrite_chat_events"();
--> statement-breakpoint
-- trigger_source has no index either; walk the primary key the same way.
CREATE OR REPLACE PROCEDURE "chat_event_v8_rewrite_agent_run_sources"()
LANGUAGE plpgsql
AS $$
DECLARE
  last_id uuid := '00000000-0000-0000-0000-000000000000';
  next_id uuid;
BEGIN
  LOOP
    SELECT "batch"."id" INTO next_id
    FROM (
      SELECT "id" FROM "agent_runs"
      WHERE "id" > last_id
      ORDER BY "id"
      LIMIT 5000
    ) AS "batch"
    ORDER BY "batch"."id" DESC
    LIMIT 1;
    EXIT WHEN next_id IS NULL;

    UPDATE "agent_runs"
    SET "trigger_source" = 'automation-schedule'
    WHERE "id" > last_id AND "id" <= next_id
      AND "trigger_source" = 'goal';

    COMMIT;
    last_id := next_id;
  END LOOP;
END;
$$;
--> statement-breakpoint
CALL "chat_event_v8_rewrite_agent_run_sources"();
--> statement-breakpoint
-- The (source, external_id) index finds the remaining Goal files directly.
-- A row whose rewrite would collide with an existing automation-schedule file
-- of the same run stops the migration instead of being merged silently.
CREATE OR REPLACE PROCEDURE "chat_event_v8_rewrite_uploaded_file_sources"()
LANGUAGE plpgsql
AS $$
DECLARE
  changed integer;
BEGIN
  LOOP
    WITH "batch" AS (
      SELECT "file"."id"
      FROM "run_uploaded_files" AS "file"
      WHERE "file"."source" = 'goal'
        AND NOT EXISTS (
          SELECT 1 FROM "run_uploaded_files" AS "existing"
          WHERE "existing"."run_id" = "file"."run_id"
            AND "existing"."source" = 'automation-schedule'
            AND "existing"."external_id" = "file"."external_id"
        )
      ORDER BY "file"."id"
      LIMIT 1000
      FOR UPDATE
    )
    UPDATE "run_uploaded_files" AS "target"
    SET "source" = 'automation-schedule'
    FROM "batch"
    WHERE "target"."id" = "batch"."id";

    GET DIAGNOSTICS changed = ROW_COUNT;
    COMMIT;
    EXIT WHEN changed = 0;
  END LOOP;
  IF EXISTS (SELECT 1 FROM "run_uploaded_files" WHERE "source" = 'goal') THEN
    RAISE EXCEPTION 'run_uploaded_files still has goal sources that collide with automation-schedule files';
  END IF;
END;
$$;
--> statement-breakpoint
CALL "chat_event_v8_rewrite_uploaded_file_sources"();
--> statement-breakpoint
-- Drafts and shares are small tables without JSON indexes; each batch selects
-- only documents that still need the rewrite.
CREATE OR REPLACE PROCEDURE "chat_event_v8_rewrite_documents"()
LANGUAGE plpgsql
AS $$
DECLARE
  changed integer;
BEGIN
  LOOP
    WITH "batch" AS (
      SELECT "chat_thread_id", "user_id"
      FROM "chat_thread_drafts"
      WHERE "draft_user_message" -> 'parts' @> '[{"type":"goal"}]'
      LIMIT 1000
      FOR UPDATE
    )
    UPDATE "chat_thread_drafts" AS "target"
    SET "draft_user_message" = "chat_event_v8_goal_parts_to_text"("target"."draft_user_message")
    FROM "batch"
    WHERE "target"."chat_thread_id" = "batch"."chat_thread_id"
      AND "target"."user_id" = "batch"."user_id";

    GET DIAGNOSTICS changed = ROW_COUNT;
    COMMIT;
    EXIT WHEN changed = 0;
  END LOOP;

  LOOP
    WITH "batch" AS (
      SELECT "user_id", "org_id", "agent_id"
      FROM "agent_drafts"
      WHERE "draft_user_message" -> 'parts' @> '[{"type":"goal"}]'
      LIMIT 1000
      FOR UPDATE
    )
    UPDATE "agent_drafts" AS "target"
    SET "draft_user_message" = "chat_event_v8_goal_parts_to_text"("target"."draft_user_message")
    FROM "batch"
    WHERE "target"."user_id" = "batch"."user_id"
      AND "target"."org_id" = "batch"."org_id"
      AND "target"."agent_id" = "batch"."agent_id";

    GET DIAGNOSTICS changed = ROW_COUNT;
    COMMIT;
    EXIT WHEN changed = 0;
  END LOOP;

  LOOP
    WITH "batch" AS (
      SELECT "id"
      FROM "shared_threads"
      WHERE jsonb_typeof("messages") = 'array'
        AND jsonb_path_exists("messages", '$[*].runGroupIndex')
      ORDER BY "id"
      LIMIT 1000
      FOR UPDATE
    )
    UPDATE "shared_threads" AS "target"
    SET "messages" = (
      SELECT jsonb_agg("message" - 'runGroupIndex' ORDER BY "position")
      FROM jsonb_array_elements("target"."messages")
        WITH ORDINALITY AS "messages"("message", "position")
    )
    FROM "batch"
    WHERE "target"."id" = "batch"."id";

    GET DIAGNOSTICS changed = ROW_COUNT;
    COMMIT;
    EXIT WHEN changed = 0;
  END LOOP;
END;
$$;
--> statement-breakpoint
CALL "chat_event_v8_rewrite_documents"();
--> statement-breakpoint
ALTER TABLE "chat_events" VALIDATE CONSTRAINT "chat_events_event_type_check";
--> statement-breakpoint
ALTER TABLE "chat_events" VALIDATE CONSTRAINT "chat_events_context_type_check";
--> statement-breakpoint
ALTER TABLE "chat_events" VALIDATE CONSTRAINT "chat_events_input_context_type_check";
--> statement-breakpoint
ALTER TABLE "chat_event_snapshots" VALIDATE CONSTRAINT "chat_event_snapshots_archive_schema_version_check";
--> statement-breakpoint
DROP PROCEDURE "chat_event_v8_rewrite_chat_events"();
--> statement-breakpoint
DROP PROCEDURE "chat_event_v8_rewrite_agent_run_sources"();
--> statement-breakpoint
DROP PROCEDURE "chat_event_v8_rewrite_uploaded_file_sources"();
--> statement-breakpoint
DROP PROCEDURE "chat_event_v8_rewrite_documents"();
--> statement-breakpoint
DROP FUNCTION "chat_event_v8_goal_parts_to_text"(jsonb);
--> statement-breakpoint
RESET lock_timeout;
--> statement-breakpoint
RESET statement_timeout;
