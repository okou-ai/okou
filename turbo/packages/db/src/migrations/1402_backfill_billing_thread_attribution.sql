-- Capture only retained billing evidence, not every historical Run. The identity
-- anchor is Run.created_at, matching current attribution writers. SQL preserves
-- its full timestamp precision. No established anchor or financial field changes.
-- Probe stable and legacy identities separately so unlinked usage does not
-- become a broad lookup path for every Run when NULL statistics are stale.
-- vm0:batch-by-uuid
WITH batch AS MATERIALIZED (
  SELECT id FROM agent_runs
  WHERE ($1::uuid IS NULL OR id > $1::uuid)
  ORDER BY id LIMIT 1000
), facts AS MATERIALIZED (
  SELECT r.id, r.org_id, r.user_id, r.created_at, r.chat_thread_id,
    CASE
      WHEN r.trigger_source = 'web' THEN 'chat'
      WHEN r.trigger_source IN ('automation-schedule', 'automation-event') THEN 'automation'
      WHEN r.trigger_source IN ('slack', 'discord', 'teams', 'telegram', 'email', 'agentphone', 'github', 'agent') THEN r.trigger_source
      ELSE 'other'
    END AS source
  FROM batch b
  JOIN agent_runs r ON r.id = b.id
  LEFT JOIN billing_run_attribution existing ON existing.run_id = r.id
  WHERE (existing.run_id IS NULL OR NOT existing.usage_observed
    OR (existing.thread_context = 'unknown' AND r.chat_thread_id IS NOT NULL))
    AND (
      (
        EXISTS (
          SELECT 1 FROM usage_event u
          WHERE u.billing_run_id = r.id
            AND (u.run_id IS NULL OR u.run_id = r.id)
            AND u.billing_context NOT IN ('runless', 'pi_memory_stage1')
            AND u.org_id = r.org_id AND u.user_id = r.user_id
            AND (u.billing_anchor_at IS NULL OR u.billing_anchor_at = r.created_at)
        ) OR EXISTS (
          SELECT 1 FROM usage_event u
          WHERE u.billing_run_id IS NULL AND u.run_id = r.id
            AND (u.run_id IS NULL OR u.run_id = r.id)
            AND u.billing_context NOT IN ('runless', 'pi_memory_stage1')
            AND u.org_id = r.org_id AND u.user_id = r.user_id
            AND (u.billing_anchor_at IS NULL OR u.billing_anchor_at = r.created_at)
        )
      ) OR (
        EXISTS (
          SELECT 1 FROM usage_event_hourly_rollup u
          WHERE u.billing_run_id = r.id
            AND (u.run_id IS NULL OR u.run_id = r.id)
            AND u.billing_context NOT IN ('runless', 'pi_memory_stage1')
            AND u.org_id = r.org_id AND u.user_id = r.user_id
            AND (u.billing_anchor_at IS NULL OR u.billing_anchor_at = r.created_at)
        ) OR EXISTS (
          SELECT 1 FROM usage_event_hourly_rollup u
          WHERE u.billing_run_id IS NULL AND u.run_id = r.id
            AND (u.run_id IS NULL OR u.run_id = r.id)
            AND u.billing_context NOT IN ('runless', 'pi_memory_stage1')
            AND u.org_id = r.org_id AND u.user_id = r.user_id
            AND (u.billing_anchor_at IS NULL OR u.billing_anchor_at = r.created_at)
        )
      )
    )
), captured AS (
  INSERT INTO billing_run_attribution AS a (
    run_id, org_id, user_id, run_started_at, source,
    thread_id, thread_context, usage_observed
  )
  SELECT r.id, r.org_id, r.user_id, r.created_at, r.source,
    r.chat_thread_id,
    CASE WHEN r.chat_thread_id IS NULL THEN 'unknown' ELSE 'thread' END, true
  FROM facts r
  LEFT JOIN chat_threads t ON t.id = r.chat_thread_id
  WHERE t.id IS NULL OR t.user_id = r.user_id
  ON CONFLICT (run_id) DO UPDATE SET
    thread_id = CASE WHEN a.thread_context = 'unknown' THEN EXCLUDED.thread_id ELSE a.thread_id END,
    thread_context = CASE WHEN a.thread_context = 'unknown' THEN EXCLUDED.thread_context ELSE a.thread_context END,
    usage_observed = true
  WHERE a.org_id = EXCLUDED.org_id AND a.user_id = EXCLUDED.user_id
    AND a.run_started_at = EXCLUDED.run_started_at AND a.source = EXCLUDED.source
    AND (a.thread_context = 'unknown' OR EXCLUDED.thread_id IS NULL OR a.thread_id = EXCLUDED.thread_id)
    AND NOT EXISTS (
      SELECT 1 FROM chat_threads t WHERE t.id = a.thread_id AND t.user_id <> a.user_id
    )
    AND (NOT a.usage_observed OR (a.thread_context = 'unknown' AND EXCLUDED.thread_id IS NOT NULL))
  RETURNING run_id
)
SELECT (SELECT id FROM batch ORDER BY id DESC LIMIT 1) AS next_cursor;
--> statement-breakpoint
-- Link retained usage_event rows only after attribution capture has completed.
-- An unavailable Run is acceptable when independent attribution already exists.
-- Conflicting identities, owners, anchors, sources and Thread facts are left
-- untouched for explicit reconciliation; they are never silently rewritten.
-- vm0:batch-by-uuid
WITH batch AS MATERIALIZED (
  SELECT id FROM usage_event
  WHERE ($1::uuid IS NULL OR id > $1::uuid)
  ORDER BY id LIMIT 1000
), eligible AS MATERIALIZED (
  SELECT u.id, a.run_id, a.run_started_at, a.org_id, a.user_id
  FROM batch b
  JOIN usage_event u ON u.id = b.id
  JOIN billing_run_attribution a ON a.run_id = COALESCE(u.billing_run_id, u.run_id)
  LEFT JOIN agent_runs r ON r.id = a.run_id
  LEFT JOIN chat_threads t ON t.id = CASE
    WHEN a.thread_context IN ('thread', 'threadless') THEN a.thread_id
    ELSE r.chat_thread_id
  END
  WHERE u.billing_context NOT IN ('runless', 'pi_memory_stage1')
    AND (u.run_id IS NULL OR u.run_id = a.run_id)
    AND u.org_id = a.org_id AND u.user_id = a.user_id
    AND (u.billing_anchor_at IS NULL OR u.billing_anchor_at = a.run_started_at)
    AND (r.id IS NULL OR (
      r.org_id = a.org_id AND r.user_id = a.user_id
      AND r.created_at = a.run_started_at
      AND a.source = CASE
        WHEN r.trigger_source = 'web' THEN 'chat'
        WHEN r.trigger_source IN ('automation-schedule', 'automation-event') THEN 'automation'
        WHEN r.trigger_source IN ('slack', 'discord', 'teams', 'telegram', 'email', 'agentphone', 'github', 'agent') THEN r.trigger_source
        ELSE 'other'
      END
      AND (a.thread_context = 'unknown' OR r.chat_thread_id IS NULL OR a.thread_id = r.chat_thread_id)
    ))
    AND (t.id IS NULL OR t.user_id = u.user_id)
), observed AS (
  UPDATE billing_run_attribution a SET usage_observed = true
  WHERE NOT a.usage_observed
    AND a.run_id IN (SELECT run_id FROM eligible)
  RETURNING a.run_id
), linked AS (
  UPDATE usage_event u SET
    billing_run_id = e.run_id, billing_anchor_at = e.run_started_at, billing_context = 'run'
  FROM eligible e
  WHERE u.id = e.id
    AND u.org_id = e.org_id
    AND u.user_id = e.user_id
    AND (u.billing_run_id IS NULL OR u.billing_run_id = e.run_id)
    AND (u.run_id IS NULL OR u.run_id = e.run_id)
    AND (u.billing_anchor_at IS NULL OR u.billing_anchor_at = e.run_started_at)
    AND u.billing_context IN ('legacy_unknown', 'missing_run')
  RETURNING u.id
)
SELECT (SELECT id FROM batch ORDER BY id DESC LIMIT 1) AS next_cursor;
--> statement-breakpoint
-- Link retained usage_event_hourly_rollup rows only after attribution capture has completed.
-- An unavailable Run is acceptable when independent attribution already exists.
-- Conflicting identities, owners, anchors, sources and Thread facts are left
-- untouched for explicit reconciliation; they are never silently rewritten.
-- vm0:batch-by-uuid
WITH batch AS MATERIALIZED (
  SELECT id FROM usage_event_hourly_rollup
  WHERE ($1::uuid IS NULL OR id > $1::uuid)
  ORDER BY id LIMIT 1000
), eligible AS MATERIALIZED (
  SELECT u.id, a.run_id, a.run_started_at, a.org_id, a.user_id
  FROM batch b
  JOIN usage_event_hourly_rollup u ON u.id = b.id
  JOIN billing_run_attribution a ON a.run_id = COALESCE(u.billing_run_id, u.run_id)
  LEFT JOIN agent_runs r ON r.id = a.run_id
  LEFT JOIN chat_threads t ON t.id = CASE
    WHEN a.thread_context IN ('thread', 'threadless') THEN a.thread_id
    ELSE r.chat_thread_id
  END
  WHERE u.billing_context NOT IN ('runless', 'pi_memory_stage1')
    AND (u.run_id IS NULL OR u.run_id = a.run_id)
    AND u.org_id = a.org_id AND u.user_id = a.user_id
    AND (u.billing_anchor_at IS NULL OR u.billing_anchor_at = a.run_started_at)
    AND (r.id IS NULL OR (
      r.org_id = a.org_id AND r.user_id = a.user_id
      AND r.created_at = a.run_started_at
      AND a.source = CASE
        WHEN r.trigger_source = 'web' THEN 'chat'
        WHEN r.trigger_source IN ('automation-schedule', 'automation-event') THEN 'automation'
        WHEN r.trigger_source IN ('slack', 'discord', 'teams', 'telegram', 'email', 'agentphone', 'github', 'agent') THEN r.trigger_source
        ELSE 'other'
      END
      AND (a.thread_context = 'unknown' OR r.chat_thread_id IS NULL OR a.thread_id = r.chat_thread_id)
    ))
    AND (t.id IS NULL OR t.user_id = u.user_id)
), observed AS (
  UPDATE billing_run_attribution a SET usage_observed = true
  WHERE NOT a.usage_observed
    AND a.run_id IN (SELECT run_id FROM eligible)
  RETURNING a.run_id
), linked AS (
  UPDATE usage_event_hourly_rollup u SET
    billing_run_id = e.run_id, billing_anchor_at = e.run_started_at, billing_context = 'run'
  FROM eligible e
  WHERE u.id = e.id
    AND u.org_id = e.org_id
    AND u.user_id = e.user_id
    AND (u.billing_run_id IS NULL OR u.billing_run_id = e.run_id)
    AND (u.run_id IS NULL OR u.run_id = e.run_id)
    AND (u.billing_anchor_at IS NULL OR u.billing_anchor_at = e.run_started_at)
    AND u.billing_context IN ('legacy_unknown', 'missing_run')
  RETURNING u.id
)
SELECT (SELECT id FROM batch ORDER BY id DESC LIMIT 1) AS next_cursor;
