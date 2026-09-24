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
CREATE OR REPLACE PROCEDURE "prepare_chat_event_delivery_routes"()
LANGUAGE plpgsql
AS $$
DECLARE changed integer;
BEGIN
  LOOP
    WITH batch AS (
      SELECT r.id, c.message_thread_id, c.chat_type, c.message_id
      FROM telegram_chat_thread_routes r
      JOIN LATERAL (
        SELECT c.message_thread_id, c.chat_type, c.message_id
        FROM chat_telegram_context c
        WHERE c.chat_thread_id = r.chat_thread_id AND c.chat_id = r.chat_id
          AND c.user_link_id = COALESCE(r.telegram_user_link_id, r.telegram_official_user_link_id)
          AND c.user_link_kind = CASE WHEN r.telegram_user_link_id IS NULL THEN 'official' ELSE 'custom' END
        ORDER BY c.created_at DESC, c.id DESC LIMIT 1
      ) c ON true
      WHERE r.delivery_message_id IS NULL
      ORDER BY r.id LIMIT 1000
    )
    UPDATE telegram_chat_thread_routes r
    SET message_thread_id = batch.message_thread_id, chat_type = batch.chat_type, delivery_message_id = batch.message_id
    FROM batch WHERE r.id = batch.id AND r.delivery_message_id IS NULL;
    GET DIAGNOSTICS changed = ROW_COUNT;
    COMMIT;
    EXIT WHEN changed = 0;
  END LOOP;
  LOOP
    WITH batch AS (
      SELECT r.id, c.is_group, c.group_id, c.channel, c.from_number, c.to_number, c.agentphone_agent_id, c.message_id
      FROM agentphone_chat_thread_routes r
      JOIN LATERAL (
        SELECT c.is_group, c.group_id, c.channel, c.from_number, c.to_number, c.agentphone_agent_id, c.message_id
        FROM chat_agentphone_context c
        WHERE c.chat_thread_id = r.chat_thread_id AND c.user_link_id = r.agentphone_user_link_id
          AND c.message_id IS NOT NULL AND c.is_group IS NOT NULL
        ORDER BY c.created_at DESC, c.id DESC LIMIT 1
      ) c ON true
      WHERE r.delivery_message_id IS NULL
      ORDER BY r.id LIMIT 1000
    )
    UPDATE agentphone_chat_thread_routes r
    SET is_group = batch.is_group, group_id = batch.group_id, channel = batch.channel,
      from_number = batch.from_number, to_number = batch.to_number, agentphone_agent_id = batch.agentphone_agent_id,
      delivery_message_id = batch.message_id
    FROM batch WHERE r.id = batch.id AND r.delivery_message_id IS NULL;
    GET DIAGNOSTICS changed = ROW_COUNT;
    COMMIT;
    EXIT WHEN changed = 0;
  END LOOP;
  LOOP
    WITH batch AS (
      SELECT r.id, c.conversation_type, c.channel_id, c.service_url
      FROM teams_chat_thread_routes r
      JOIN LATERAL (
        SELECT c.conversation_type, c.channel_id, c.service_url FROM chat_teams_context c
        WHERE c.chat_thread_id = r.chat_thread_id AND c.connection_id = r.connection_id
          AND c.conversation_id = r.conversation_id AND c.thread_id = r.thread_id AND c.service_url IS NOT NULL
        ORDER BY c.created_at DESC, c.id DESC LIMIT 1
      ) c ON true
      WHERE r.service_url IS NULL
      ORDER BY r.id LIMIT 1000
    )
    UPDATE teams_chat_thread_routes r SET conversation_type = batch.conversation_type,
      channel_id = batch.channel_id, service_url = batch.service_url
    FROM batch WHERE r.id = batch.id AND r.service_url IS NULL;
    GET DIAGNOSTICS changed = ROW_COUNT;
    COMMIT;
    EXIT WHEN changed = 0;
  END LOOP;
  LOOP
    WITH batch AS (
      SELECT r.id, c.subject_kind
      FROM github_chat_thread_routes r
      JOIN LATERAL (
        SELECT c.subject_kind FROM chat_github_context c
        WHERE c.chat_thread_id = r.chat_thread_id AND c.repo = r.repo AND c.subject_number = r.subject_number
        ORDER BY c.created_at DESC, c.id DESC LIMIT 1
      ) c ON true
      WHERE r.subject_kind IS NULL
      ORDER BY r.id LIMIT 1000
    )
    UPDATE github_chat_thread_routes r SET subject_kind = batch.subject_kind
    FROM batch WHERE r.id = batch.id AND r.subject_kind IS NULL;
    GET DIAGNOSTICS changed = ROW_COUNT;
    COMMIT;
    EXIT WHEN changed = 0;
  END LOOP;
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
CALL "prepare_chat_event_delivery_routes"();
--> statement-breakpoint
DROP PROCEDURE "prepare_chat_event_delivery_routes"();

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
