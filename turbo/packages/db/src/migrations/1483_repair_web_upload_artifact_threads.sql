-- okou:non-transactional
-- Release after #43741 is in production and its outgoing API requests drain.
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
-- Private upload completion used to register the ownership file before its
-- producing Run. The catalog kept that first, threadless origin when the Run
-- replaced its projection. Repair only that exact two-record lifecycle.
-- Select the first producing record before checking its thread: a deleted
-- origin must never fall through to a later upload in another conversation.
-- okou:batch-by-uuid
WITH batch AS MATERIALIZED (
  SELECT id, org_id, author_user_id, projection_file_id, created_at, source_url
  FROM artifacts
  WHERE ($1::uuid IS NULL OR id > $1::uuid)
    AND kind = 'file' AND logical_key LIKE 'file:%'
    AND chat_thread_id IS NULL
  ORDER BY id LIMIT 1000
), origins AS MATERIALIZED (
  SELECT batch.id, batch.projection_file_id, first_upload.chat_thread_id
  FROM batch
  JOIN run_uploaded_files projection ON projection.id = batch.projection_file_id
    AND projection.org_id = batch.org_id
    AND projection.user_id = batch.author_user_id
    AND projection.run_id IS NOT NULL
    AND projection.url = batch.source_url
    AND projection.classification IS DISTINCT FROM 'input'
  JOIN run_uploaded_files ownership ON ownership.id = CASE
    WHEN projection.external_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN projection.external_id::uuid END
    AND ownership.org_id = batch.org_id
    AND ownership.user_id = batch.author_user_id
    AND ownership.run_id IS NULL AND ownership.chat_thread_id IS NULL
    AND ownership.created_at = batch.created_at
    AND ownership.url = projection.url
    AND ownership.storage_key = projection.metadata ->> 's3Key'
    AND ownership.metadata ->> 'storage' = 'private-artifact-v1'
    AND ownership.metadata ->> 'purpose' = 'artifact'
    AND ownership.classification IS DISTINCT FROM 'input'
  CROSS JOIN LATERAL (
    SELECT uploaded.run_id, uploaded.chat_thread_id, uploaded.created_at
    FROM run_uploaded_files uploaded
    WHERE uploaded.external_id = ownership.id::text
      AND uploaded.source IN (
        'automation-schedule', 'automation-event', 'web', 'slack', 'discord',
        'wechat', 'teams', 'feishu', 'lark', 'email', 'telegram', 'agentphone',
        'github', 'cli', 'agent'
      )
      AND uploaded.org_id = batch.org_id
      AND uploaded.user_id = batch.author_user_id
      AND uploaded.run_id IS NOT NULL
    ORDER BY uploaded.created_at, uploaded.id LIMIT 1
  ) first_upload
  JOIN chat_threads thread ON thread.id = first_upload.chat_thread_id
    AND thread.user_id = batch.author_user_id
  JOIN agent_runs producing_run ON producing_run.id = first_upload.run_id
    AND producing_run.chat_thread_id = first_upload.chat_thread_id
    AND producing_run.org_id = batch.org_id
    AND producing_run.trigger_source IS NOT NULL
  -- The owning upload must have been prepared during this Run. A file created
  -- outside a Run and reused later does not acquire a creating conversation.
  WHERE ownership.created_at >= producing_run.created_at
    AND (producing_run.completed_at IS NULL
      OR ownership.created_at <= producing_run.completed_at)
    AND first_upload.created_at >= ownership.created_at
    AND NOT EXISTS (
      SELECT 1 FROM run_uploaded_files competing
      WHERE competing.external_id = ownership.id::text
        AND competing.source IN (
          'automation-schedule', 'automation-event', 'web', 'slack', 'discord',
          'wechat', 'teams', 'feishu', 'lark', 'email', 'telegram', 'agentphone',
          'github', 'cli', 'agent'
        )
        AND competing.org_id = batch.org_id
        AND competing.user_id = batch.author_user_id
        AND competing.run_id IS NOT NULL
        AND competing.created_at = first_upload.created_at
        AND competing.chat_thread_id IS DISTINCT FROM first_upload.chat_thread_id
    )
), updated AS (
  UPDATE artifacts target SET chat_thread_id = origins.chat_thread_id
  FROM origins
  WHERE target.id = origins.id AND target.chat_thread_id IS NULL
    AND target.projection_file_id = origins.projection_file_id
  RETURNING target.id
)
SELECT (SELECT id FROM batch ORDER BY id DESC LIMIT 1) AS next_cursor;
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
RESET lock_timeout;
