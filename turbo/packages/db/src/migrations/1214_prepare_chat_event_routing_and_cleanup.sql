-- vm0:non-transactional
-- Existing hot tables receive online indexes. Every batch below commits independently.
SET lock_timeout = '1s';
--> statement-breakpoint
-- Concurrent builds and committed batch scans may exceed the normal 10s statement limit.
SET statement_timeout = '10min';
--> statement-breakpoint
-- Retry may encounter an invalid index from an interrupted concurrent build.
DROP INDEX CONCURRENTLY IF EXISTS "idx_agentphone_chat_thread_routes_thread";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "idx_agentphone_chat_thread_routes_thread" ON "agentphone_chat_thread_routes" USING btree ("chat_thread_id");
--> statement-breakpoint
-- Retry may encounter an invalid index from an interrupted concurrent build.
DROP INDEX CONCURRENTLY IF EXISTS "idx_background_jobs_completed_clerk_deletion";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "idx_background_jobs_completed_clerk_deletion" ON "background_jobs" USING btree ("id") WHERE "background_jobs"."kind" = 'clerk-user-deletion' AND "background_jobs"."status" = 'completed';
--> statement-breakpoint
-- Retry may encounter an invalid index from an interrupted concurrent build.
DROP INDEX CONCURRENTLY IF EXISTS "chat_agent_run_context_source_user_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "chat_agent_run_context_source_user_idx" ON "chat_agent_run_context" USING btree ("source_user_id");
--> statement-breakpoint
-- Retry may encounter an invalid index from an interrupted concurrent build.
DROP INDEX CONCURRENTLY IF EXISTS "chat_agent_run_context_source_org_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "chat_agent_run_context_source_org_idx" ON "chat_agent_run_context" USING btree ("source_org_id");
--> statement-breakpoint
-- Retry may encounter an invalid index from an interrupted concurrent build.
DROP INDEX CONCURRENTLY IF EXISTS "chat_agentphone_context_thread_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "chat_agentphone_context_thread_idx" ON "chat_agentphone_context" USING btree ("chat_thread_id");
--> statement-breakpoint
-- Retry may encounter an invalid index from an interrupted concurrent build.
DROP INDEX CONCURRENTLY IF EXISTS "chat_automation_context_thread_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "chat_automation_context_thread_idx" ON "chat_automation_context" USING btree ("chat_thread_id");
--> statement-breakpoint
-- Retry may encounter an invalid index from an interrupted concurrent build.
DROP INDEX CONCURRENTLY IF EXISTS "chat_feishu_context_thread_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "chat_feishu_context_thread_idx" ON "chat_feishu_context" USING btree ("chat_thread_id");
--> statement-breakpoint
-- Retry may encounter an invalid index from an interrupted concurrent build.
DROP INDEX CONCURRENTLY IF EXISTS "chat_github_context_thread_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "chat_github_context_thread_idx" ON "chat_github_context" USING btree ("chat_thread_id");
--> statement-breakpoint
-- Retry may encounter an invalid index from an interrupted concurrent build.
DROP INDEX CONCURRENTLY IF EXISTS "chat_slack_context_thread_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "chat_slack_context_thread_idx" ON "chat_slack_context" USING btree ("chat_thread_id");
--> statement-breakpoint
-- Retry may encounter an invalid index from an interrupted concurrent build.
DROP INDEX CONCURRENTLY IF EXISTS "chat_teams_context_thread_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "chat_teams_context_thread_idx" ON "chat_teams_context" USING btree ("chat_thread_id");
--> statement-breakpoint
-- Retry may encounter an invalid index from an interrupted concurrent build.
DROP INDEX CONCURRENTLY IF EXISTS "chat_telegram_context_thread_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "chat_telegram_context_thread_idx" ON "chat_telegram_context" USING btree ("chat_thread_id");
--> statement-breakpoint
-- Retry may encounter an invalid index from an interrupted concurrent build.
DROP INDEX CONCURRENTLY IF EXISTS "chat_thread_events_org_idx";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "chat_thread_events_org_idx" ON "chat_thread_events" USING btree ("org_id");
--> statement-breakpoint
-- Retry may encounter an invalid index from an interrupted concurrent build.
DROP INDEX CONCURRENTLY IF EXISTS "idx_github_chat_thread_routes_thread";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "idx_github_chat_thread_routes_thread" ON "github_chat_thread_routes" USING btree ("chat_thread_id");
--> statement-breakpoint
-- Retry may encounter an invalid index from an interrupted concurrent build.
DROP INDEX CONCURRENTLY IF EXISTS "idx_teams_chat_thread_routes_thread";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "idx_teams_chat_thread_routes_thread" ON "teams_chat_thread_routes" USING btree ("chat_thread_id");
--> statement-breakpoint
-- Retry may encounter an invalid index from an interrupted concurrent build.
DROP INDEX CONCURRENTLY IF EXISTS "idx_telegram_chat_thread_routes_thread";
--> statement-breakpoint
CREATE INDEX CONCURRENTLY "idx_telegram_chat_thread_routes_thread" ON "telegram_chat_thread_routes" USING btree ("chat_thread_id");
--> statement-breakpoint
CREATE OR REPLACE PROCEDURE "backfill_chat_agent_run_context_ownership"()
LANGUAGE plpgsql
AS $$
DECLARE changed integer;
BEGIN
  LOOP
    WITH batch AS (
      SELECT c.id, t.user_id, a.org_id FROM chat_agent_run_context c
      JOIN chat_threads t ON t.id = c.source_chat_thread_id
      JOIN agents a ON a.id = c.source_agent_id AND a.id = t.agent_id
      WHERE c.source_user_id IS NULL OR c.source_org_id IS NULL
      ORDER BY c.id LIMIT 1000
    )
    UPDATE chat_agent_run_context c SET source_user_id = batch.user_id, source_org_id = batch.org_id
    FROM batch WHERE c.id = batch.id AND (c.source_user_id IS NULL OR c.source_org_id IS NULL);
    GET DIAGNOSTICS changed = ROW_COUNT;
    COMMIT;
    EXIT WHEN changed = 0;
  END LOOP;
END $$;

--> statement-breakpoint
CALL "backfill_chat_agent_run_context_ownership"();
--> statement-breakpoint
DROP PROCEDURE "backfill_chat_agent_run_context_ownership"();

--> statement-breakpoint
CREATE OR REPLACE PROCEDURE "seed_chat_content_erasure_receipts"()
LANGUAGE plpgsql
AS $$
DECLARE
  last_job uuid := '00000000-0000-0000-0000-000000000000';
  next_job uuid;
BEGIN
  LOOP
    WITH batch AS MATERIALIZED (
      SELECT id, subject_kind, subject_id, decision_ref, requested_at, generation
      FROM account_erasure_jobs
      WHERE id > last_job AND state IN ('verified_erased', 'verified_no_applicable_data')
      ORDER BY id LIMIT 1000
    ), confirmed AS (
      SELECT DISTINCT ON (subject_kind, subject_id)
        subject_kind, subject_id, decision_ref, requested_at
      FROM batch ORDER BY subject_kind, subject_id, generation DESC
    ), copied AS (
      INSERT INTO chat_content_erasure_subjects (
        subject_kind, subject_id, source_reference, confirmed_at, completed_at
      )
      SELECT subject_kind, subject_id, decision_ref::text, requested_at, clock_timestamp()
      FROM confirmed ORDER BY subject_kind, subject_id
      ON CONFLICT (subject_kind, subject_id) DO UPDATE
        SET completed_at = COALESCE(chat_content_erasure_subjects.completed_at, EXCLUDED.completed_at)
      RETURNING subject_id
    )
    SELECT id INTO next_job FROM batch ORDER BY id DESC LIMIT 1;
    COMMIT;
    EXIT WHEN next_job IS NULL;
    last_job := next_job;
  END LOOP;
  last_job := '00000000-0000-0000-0000-000000000000';
  LOOP
    WITH batch AS MATERIALIZED (
      SELECT id, user_id, created_at, completed_at
      FROM background_jobs
      WHERE id > last_job AND kind = 'clerk-user-deletion' AND status = 'completed'
      ORDER BY id LIMIT 1000
    ), confirmed AS (
      SELECT DISTINCT ON (user_id) id, user_id, created_at, completed_at
      FROM batch ORDER BY user_id, completed_at DESC, id DESC
    ), copied AS (
      INSERT INTO chat_content_erasure_subjects (
        subject_kind, subject_id, source_reference, confirmed_at, completed_at
      )
      SELECT 'user', user_id, id::text, created_at AT TIME ZONE 'UTC', completed_at AT TIME ZONE 'UTC'
      FROM confirmed ORDER BY user_id
      ON CONFLICT (subject_kind, subject_id) DO UPDATE
        SET completed_at = COALESCE(chat_content_erasure_subjects.completed_at, EXCLUDED.completed_at)
      RETURNING subject_id
    )
    SELECT id INTO next_job FROM batch ORDER BY id DESC LIMIT 1;
    COMMIT;
    EXIT WHEN next_job IS NULL;
    last_job := next_job;
  END LOOP;
END;
$$;
--> statement-breakpoint
CALL "seed_chat_content_erasure_receipts"();
--> statement-breakpoint
DROP PROCEDURE "seed_chat_content_erasure_receipts"();
--> statement-breakpoint
RESET lock_timeout;
--> statement-breakpoint
RESET statement_timeout;
