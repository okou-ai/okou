-- okou:non-transactional
-- Preparation writers shipped before this backfill. Only receipt lifecycle
-- metadata changes; identity, Thread attribution and financial facts stay put.
-- Each batch commits independently. A full retry safely revisits earlier IDs.
SET statement_timeout = '2s';
--> statement-breakpoint
-- okou:batch-by-uuid
-- okou:explain-on-timeout
WITH batch AS MATERIALIZED (
  -- Bound work before looking up Runs, including batches with no updates.
  SELECT run_id FROM billing_run_attribution
  WHERE ($1::uuid IS NULL OR run_id > $1::uuid)
  ORDER BY run_id LIMIT 500
), facts AS MATERIALIZED (
  SELECT a.run_id, a.org_id, a.user_id, a.run_started_at, a.source,
    a.run_lifecycle_context, a.run_terminal_status, a.run_completed_at,
    r.id AS retained_run_id, r.org_id AS run_org_id, r.user_id AS run_user_id,
    r.created_at, r.status, r.completed_at,
    CASE
      WHEN r.trigger_source = 'web' THEN 'chat'
      WHEN r.trigger_source IN ('automation-schedule', 'automation-event') THEN 'automation'
      WHEN r.trigger_source IN ('slack', 'discord', 'wechat', 'teams', 'telegram', 'email', 'agentphone', 'github', 'agent') THEN r.trigger_source
      ELSE 'other'
    END AS run_source
  FROM batch b
  JOIN billing_run_attribution a ON a.run_id = b.run_id
  LEFT JOIN agent_runs r ON r.id = a.run_id
), conflicts AS MATERIALIZED (
  SELECT run_id FROM facts
  WHERE retained_run_id IS NOT NULL AND (
    org_id <> run_org_id OR user_id <> run_user_id
    OR run_started_at <> created_at OR source <> run_source
    OR status NOT IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'timeout')
    OR (status IN ('pending', 'running') AND completed_at IS NOT NULL)
    OR run_lifecycle_context = 'legacy_unavailable'
    OR (run_terminal_status IS NOT NULL AND (
      run_terminal_status <> status
      OR (run_completed_at IS NOT NULL AND completed_at IS NOT NULL
        AND run_completed_at <> completed_at)
    ))
  )
), captured AS (
  UPDATE billing_run_attribution a SET
    run_lifecycle_context = 'captured',
    run_terminal_status = CASE
      WHEN f.status IN ('completed', 'failed', 'cancelled', 'timeout') THEN f.status
      ELSE NULL
    END,
    run_completed_at = CASE
      WHEN f.status IN ('completed', 'failed', 'cancelled', 'timeout') THEN f.completed_at
      ELSE NULL
    END
  FROM facts f
  WHERE a.run_id = f.run_id AND f.retained_run_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM conflicts)
    -- Recheck the winning attribution row after any concurrent terminal write.
    AND a.org_id = f.run_org_id AND a.user_id = f.run_user_id
    AND a.run_started_at = f.created_at AND a.source = f.run_source
    AND a.run_lifecycle_context IN ('unknown', 'captured')
    AND (
      (a.run_terminal_status IS NULL AND (
        a.run_lifecycle_context = 'unknown'
        OR f.status IN ('completed', 'failed', 'cancelled', 'timeout')
      ))
      OR (a.run_terminal_status = f.status
        AND a.run_completed_at IS NULL AND f.completed_at IS NOT NULL)
    )
  RETURNING a.run_id
), unavailable AS (
  UPDATE billing_run_attribution a SET run_lifecycle_context = 'legacy_unavailable'
  FROM facts f
  WHERE a.run_id = f.run_id AND f.retained_run_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM conflicts)
    AND a.run_lifecycle_context IN ('unknown', 'captured')
    -- A retained terminal receipt remains authoritative after Run deletion.
    AND a.run_terminal_status IS NULL AND a.run_completed_at IS NULL
  RETURNING a.run_id
)
-- Fail the batch without exposing IDs or certifying a conflicted migration.
-- Earlier committed batches remain safe to replay after reconciliation.
SELECT CASE WHEN EXISTS (SELECT 1 FROM conflicts)
  THEN ('billing run lifecycle backfill conflict: ' || (SELECT count(*) FROM conflicts))::uuid
  ELSE (SELECT run_id FROM batch ORDER BY run_id DESC LIMIT 1)
END AS next_cursor;
--> statement-breakpoint
RESET statement_timeout;
