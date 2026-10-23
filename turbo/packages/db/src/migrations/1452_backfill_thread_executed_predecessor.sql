-- okou:non-transactional
-- #42358 release 2: first-claim writers shipped in API 1.765.2 (d635f043).
-- The outgoing API's 300-second drain ended at 2026-10-22 12:08:40 UTC.
-- Executions at/after that writer floor are already maintained; leave them intact.
-- Historical readers stay enabled. Missing/conflicted history stays unresolved.
-- Each UUID batch commits independently and is safe to revisit after failure.
-- Keep the tenant-scoped latest execution lookup on one ordered index. Combining
-- the Thread and organization indexes can repeatedly scan a large organization.
-- Replace a possibly invalid index left by an interrupted concurrent build.
SET statement_timeout = '5min';
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS public.migration_1452_run_thread_owner_executed_idx;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY migration_1452_run_thread_owner_executed_idx
  ON public.agent_runs (chat_thread_id, user_id, org_id,
    started_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC NULLS LAST)
  WHERE chat_thread_id IS NOT NULL AND started_at IS NOT NULL;
--> statement-breakpoint
SET statement_timeout = '2s';
--> statement-breakpoint
-- okou:batch-by-uuid
-- okou:explain-on-timeout
WITH batch AS MATERIALIZED (
  -- Bound Thread and indexed predecessor lookups before inspecting history.
  SELECT id, user_id, agent_id, framework_session_run_id,
    framework, framework_session_id
  FROM chat_threads
  WHERE ($1::uuid IS NULL OR id > $1::uuid)
  ORDER BY id LIMIT 100
), facts AS MATERIALIZED (
  SELECT b.*, latest.id AS latest_run_id,
    latest.started_at AS latest_started_at,
    latest.agent_id AS latest_agent_id,
    latest.framework AS latest_framework,
    latest.framework_session_id AS latest_session_id,
    producer.id AS producer_id, producer.chat_thread_id AS producer_thread_id,
    producer.user_id AS producer_user_id, producer.org_id AS producer_org_id,
    producer.agent_id AS producer_agent_id, producer.started_at AS producer_started_at,
    a.org_id
  FROM batch b
  JOIN agents a ON a.id = b.agent_id
  LEFT JOIN agent_runs producer ON producer.id = b.framework_session_run_id
  CROSS JOIN LATERAL (
    -- Match previous-chat-run.ts: identity first, irrespective of native readiness
    -- or terminal outcome. No successor creation bound exists for a Thread census.
    SELECT r.id, r.started_at, r.agent_id, r.framework, r.framework_session_id
    FROM agent_runs r
    WHERE r.chat_thread_id = b.id AND r.user_id = b.user_id AND r.org_id = a.org_id
      AND r.started_at IS NOT NULL
    ORDER BY r.started_at DESC NULLS LAST, r.created_at DESC NULLS LAST,
      r.id DESC NULLS LAST
    LIMIT 1
  ) latest
), repairs AS MATERIALIZED (
  SELECT *, CASE WHEN framework_session_run_id = latest_run_id
    AND framework = latest_framework AND framework_session_id = latest_session_id
    AND framework IS NOT NULL AND framework_session_id IS NOT NULL
    THEN framework END AS kept_framework,
    CASE WHEN framework_session_run_id = latest_run_id
    AND framework = latest_framework AND framework_session_id = latest_session_id
    AND framework IS NOT NULL AND framework_session_id IS NOT NULL
    THEN framework_session_id END AS kept_session_id
  FROM facts
  WHERE latest_started_at < timestamp '2026-10-22 12:08:40'
    AND latest_agent_id = agent_id
    -- An opaque pointer with unavailable/foreign history is not proof of an
    -- earlier execution. Preserve it for explicit disposition before cutover.
    AND (framework_session_run_id IS NULL OR (
      producer_id IS NOT NULL AND producer_thread_id = id
      AND producer_user_id = user_id AND producer_org_id = org_id
      AND producer_agent_id = agent_id AND producer_started_at IS NOT NULL
      AND producer_started_at < timestamp '2026-10-22 12:08:40'
    ))
), updated AS (
  UPDATE chat_threads t SET
    framework_session_run_id = r.latest_run_id,
    framework = r.kept_framework,
    framework_session_id = r.kept_session_id
  FROM repairs r
  WHERE t.id = r.id AND t.user_id = r.user_id AND t.agent_id = r.agent_id
    -- Rechecked on the winning Thread row after any implicit UPDATE wait.
    -- A first claim or native publication that changed the binding wins intact.
    AND t.framework_session_run_id IS NOT DISTINCT FROM r.framework_session_run_id
    AND t.framework IS NOT DISTINCT FROM r.framework
    AND t.framework_session_id IS NOT DISTINCT FROM r.framework_session_id
    AND (t.framework_session_run_id IS DISTINCT FROM r.latest_run_id
      OR t.framework IS DISTINCT FROM r.kept_framework
      OR t.framework_session_id IS DISTINCT FROM r.kept_session_id)
  RETURNING t.id
)
-- Advance by inspected Threads, including empty, unresolved and unchanged batches.
SELECT (SELECT id FROM batch ORDER BY id DESC LIMIT 1) AS next_cursor;
--> statement-breakpoint
SET statement_timeout = '5min';
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS public.migration_1452_run_thread_owner_executed_idx;
--> statement-breakpoint
RESET statement_timeout;
