-- #42358 release 2 follow-up: repair the single audited historical Thread.
-- Its latest executed Run belongs to the same Thread/user/organization, but
-- names another Agent in that organization. Retain execution identity only;
-- the current Thread Agent remains authoritative and native readiness stays NULL.
-- The five audited completed producers without started_at keep their existing
-- bindings unchanged. Do not fabricate execution times or broaden live readers.
WITH repair AS MATERIALIZED (
  SELECT t.id, t.user_id, t.agent_id, latest.id AS run_id
  FROM chat_threads t
  JOIN agents current_agent ON current_agent.id = t.agent_id
  CROSS JOIN LATERAL (
    -- Select identity before eligibility; never skip a newer executed Run.
    SELECT r.id, r.agent_id, r.status, r.created_at, r.started_at, r.completed_at
    FROM agent_runs r
    WHERE r.chat_thread_id = t.id AND r.user_id = t.user_id
      AND r.org_id = current_agent.org_id AND r.started_at IS NOT NULL
    ORDER BY r.started_at DESC NULLS LAST, r.created_at DESC NULLS LAST,
      r.id DESC NULLS LAST
    LIMIT 1
  ) latest
  JOIN agents historical_agent ON historical_agent.id = latest.agent_id
    AND historical_agent.org_id = current_agent.org_id
  WHERE t.id = '91ee07fe-a872-4f1e-bf88-eed3c2feefde'::uuid
    AND t.framework_session_run_id IS NULL
    AND t.framework IS NULL AND t.framework_session_id IS NULL
    AND latest.agent_id <> t.agent_id AND latest.status = 'completed'
    AND latest.created_at < timestamp '2026-10-22 12:08:40'
    AND latest.started_at < timestamp '2026-10-22 12:08:40'
    AND latest.completed_at < timestamp '2026-10-22 12:08:40'
    AND NOT EXISTS (
      SELECT 1 FROM active_agent_runs active WHERE active.chat_thread_id = t.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM agent_runs unsettled
      WHERE unsettled.chat_thread_id = t.id AND unsettled.status IN ('pending', 'running')
    )
)
UPDATE chat_threads t SET framework_session_run_id = repair.run_id
FROM repair
WHERE t.id = repair.id AND t.user_id = repair.user_id AND t.agent_id = repair.agent_id
  -- Rechecked on the winning row after any implicit UPDATE wait. A newer claim
  -- or native publication wins intact, and a repeated migration is a no-op.
  AND t.framework_session_run_id IS NULL
  AND t.framework IS NULL AND t.framework_session_id IS NULL;
