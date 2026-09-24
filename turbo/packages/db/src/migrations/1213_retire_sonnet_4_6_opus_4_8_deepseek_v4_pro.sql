-- Retire Claude Sonnet 4.6, Claude Opus 4.8 and DeepSeek V4 Pro from run
-- selection. Production was migrated on 2026-09-24 by a reviewed batched
-- script; this is its single-transaction, set-based equivalent for other
-- environments and straggler rows, so it is a near no-op in production.
-- Remaining configuration references move to the replacement model. Completed
-- runs, chat events, usage, pricing and per-model model_settings keys stay.
CREATE TEMP TABLE model_retirement_map (
  source varchar(255) PRIMARY KEY,
  target varchar(255) NOT NULL
) ON COMMIT DROP;
--> statement-breakpoint
INSERT INTO model_retirement_map (source, target) VALUES
  ('deepseek-v4-pro', 'deepseek-v4.1-flash'),
  ('claude-sonnet-4-6', 'claude-sonnet-5'),
  ('claude-opus-4-8', 'claude-opus-5-5');
--> statement-breakpoint
-- Stop new organization adoption. Existing catalog rows only.
UPDATE run_model_catalog AS catalog
SET allow_new_org_policy = false, updated_at = now()
FROM model_retirement_map AS map
WHERE catalog.model = map.source AND catalog.allow_new_org_policy;
--> statement-breakpoint
-- Serialize with API policy writes (model-policy.service.ts lockPolicyWrites),
-- acquiring the per-organization locks in org_id order.
SELECT pg_advisory_xact_lock(hashtextextended('model-policy:' || affected.org_id, 0))
FROM (
  SELECT DISTINCT policy.org_id
  FROM org_model_policies AS policy
  JOIN model_retirement_map AS map ON map.source = policy.model
) AS affected
ORDER BY affected.org_id;
--> statement-breakpoint
-- The organization already has the replacement: delete the retired policy
-- first (idx_org_model_policies_one_default_per_org), then move its default.
WITH removed AS (
  DELETE FROM org_model_policies AS source_policy
  USING model_retirement_map AS map
  WHERE source_policy.model = map.source
    AND EXISTS (
      SELECT 1
      FROM org_model_policies AS target_policy
      WHERE target_policy.org_id = source_policy.org_id
        AND target_policy.model = map.target
    )
  RETURNING source_policy.org_id, map.target, source_policy.is_default
)
UPDATE org_model_policies AS target_policy
SET is_default = true, updated_at = now()
FROM removed
WHERE removed.is_default
  AND target_policy.org_id = removed.org_id
  AND target_policy.model = removed.target;
--> statement-breakpoint
-- Otherwise rename in place, keeping the route columns and default flag.
UPDATE org_model_policies AS policy
SET model = map.target, updated_at = now()
FROM model_retirement_map AS map
WHERE policy.model = map.source;
--> statement-breakpoint
UPDATE org_members_metadata AS member
SET selected_model = map.target, updated_at = now()
FROM model_retirement_map AS map
WHERE member.selected_model = map.source;
--> statement-breakpoint
UPDATE agents AS agent
SET selected_model = map.target, updated_at = now()
FROM model_retirement_map AS map
WHERE agent.selected_model = map.source;
--> statement-breakpoint
UPDATE model_providers AS provider
SET selected_model = map.target, updated_at = now()
FROM model_retirement_map AS map
WHERE provider.selected_model = map.source;
--> statement-breakpoint
-- chat_threads has no selected_model index: scan it once. The organization
-- comes from the thread's agent; agentless threads have no event stream.
CREATE TEMP TABLE model_retirement_threads ON COMMIT DROP AS
SELECT
  thread.id AS thread_id,
  thread.user_id,
  agent.org_id,
  thread.agent_id,
  map.target,
  row_number() OVER (
    PARTITION BY thread.user_id, agent.org_id
    ORDER BY thread.id
  ) AS rn
FROM chat_threads AS thread
JOIN model_retirement_map AS map ON map.source = thread.selected_model
LEFT JOIN agents AS agent ON agent.id = thread.agent_id;
--> statement-breakpoint
UPDATE chat_threads AS thread
SET selected_model = moved.target, updated_at = now()
FROM model_retirement_threads AS moved
WHERE thread.id = moved.thread_id;
--> statement-breakpoint
-- Reserve one contiguous seq_id range per (user_id, org_id) stream, in key
-- order, and append one model_selection_updated event per re-pinned thread.
WITH counts AS (
  SELECT user_id, org_id, count(*) AS cnt
  FROM model_retirement_threads
  WHERE org_id IS NOT NULL
  GROUP BY user_id, org_id
),
reserved AS (
  INSERT INTO chat_thread_event_sequences (user_id, org_id, last_seq_id)
  SELECT user_id, org_id, cnt
  FROM counts
  ORDER BY user_id, org_id
  ON CONFLICT (user_id, org_id) DO UPDATE
    SET last_seq_id = chat_thread_event_sequences.last_seq_id + EXCLUDED.last_seq_id
  RETURNING user_id, org_id, last_seq_id
)
INSERT INTO chat_thread_events (
  user_id, org_id, seq_id, chat_thread_id, kind, agent_id, selected_model,
  cloud_browser_enabled, created_at
)
SELECT
  moved.user_id,
  moved.org_id,
  reserved.last_seq_id - counts.cnt + moved.rn,
  moved.thread_id,
  'model_selection_updated',
  moved.agent_id,
  moved.target,
  false,
  now()
FROM model_retirement_threads AS moved
JOIN reserved USING (user_id, org_id)
JOIN counts USING (user_id, org_id);
--> statement-breakpoint
DO $$
DECLARE
  remaining_count bigint;
  multi_default_count bigint;
BEGIN
  SELECT count(*) INTO remaining_count
  FROM (
    SELECT 1 FROM org_model_policies
      WHERE model IN (SELECT source FROM model_retirement_map)
    UNION ALL
    SELECT 1 FROM org_members_metadata
      WHERE selected_model IN (SELECT source FROM model_retirement_map)
    UNION ALL
    SELECT 1 FROM agents
      WHERE selected_model IN (SELECT source FROM model_retirement_map)
    UNION ALL
    SELECT 1 FROM model_providers
      WHERE selected_model IN (SELECT source FROM model_retirement_map)
    UNION ALL
    SELECT 1 FROM chat_threads
      WHERE selected_model IN (SELECT source FROM model_retirement_map)
  ) AS remaining;

  SELECT count(*) INTO multi_default_count
  FROM (
    SELECT org_id
    FROM org_model_policies
    WHERE is_default
    GROUP BY org_id
    HAVING count(*) > 1
  ) AS multi_default;

  IF remaining_count <> 0 OR multi_default_count <> 0 THEN
    RAISE EXCEPTION 'Model retirement left % references and % organizations with multiple defaults',
      remaining_count, multi_default_count;
  END IF;
END
$$;
