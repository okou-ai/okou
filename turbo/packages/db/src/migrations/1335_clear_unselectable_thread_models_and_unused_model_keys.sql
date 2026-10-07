-- Built-in runs read only the OpenRouter key (AUTO_RUN_KEY_VENDOR). Every API
-- at or above the rollback floor selects that vendor alone, so the other
-- vendor keys are unused credentials. Revoking them upstream is a separate
-- operator action.
DELETE FROM built_in_model_keys
WHERE vendor IN ('zai', 'anthropic', 'openai', 'deepseek', 'minimax', 'moonshot');
--> statement-breakpoint
-- Chat threads whose stored selection the API cannot resolve: the id is not a
-- run_model_catalog model and is not the upstream id of a model route (the
-- two lookups of catalogModelForSelectedId). They return to Auto (NULL), as
-- if the owner had picked Auto: the snapshot changes and the owner's thread
-- event stream gets one model_selection_updated event with a NULL model. A
-- stored Codex service tier is cleared with its service_tier_updated event,
-- as the model selection route does for Auto. model_settings keeps its
-- per-model entries, like any model change.
--
-- chat_threads has no selected_model index: scan it once, like 1213 and 1299.
-- The organization comes from the thread's agent; agentless threads have no
-- event stream.
CREATE TEMP TABLE unselectable_thread_models ON COMMIT DROP AS
SELECT
  thread.id AS thread_id,
  thread.user_id,
  agent.org_id,
  thread.agent_id,
  thread.selected_model AS source,
  thread.codex_service_tier IS NOT NULL AS clears_service_tier
FROM chat_threads AS thread
LEFT JOIN agents AS agent ON agent.id = thread.agent_id
WHERE thread.selected_model IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM run_model_catalog AS catalog
    WHERE catalog.model = btrim(thread.selected_model)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM model_routes AS route
    WHERE route.upstream_model = btrim(thread.selected_model)
  );
--> statement-breakpoint
-- The snapshot was read without row locks. Re-check the selection under the
-- UPDATE's row lock so a selection a still-serving API changed in between is
-- kept, and drop it from the snapshot so it gets no event.
WITH cleared AS (
  UPDATE chat_threads AS thread
  SET
    selected_model = NULL,
    codex_service_tier = NULL,
    updated_at = timezone('UTC', now())
  FROM unselectable_thread_models AS stale
  WHERE thread.id = stale.thread_id
    AND thread.selected_model = stale.source
  RETURNING thread.id
)
DELETE FROM unselectable_thread_models AS stale
WHERE NOT EXISTS (
  SELECT 1 FROM cleared WHERE cleared.id = stale.thread_id
);
--> statement-breakpoint
-- Events in the order the selection route writes them: the model event, then
-- the service tier event. Reserve one contiguous seq_id range per
-- (user_id, org_id) stream, in key order, as 1213 and 1299 do.
CREATE TEMP TABLE unselectable_thread_model_events ON COMMIT DROP AS
SELECT
  stale.user_id,
  stale.org_id,
  stale.thread_id,
  stale.agent_id,
  event.kind,
  row_number() OVER (
    PARTITION BY stale.user_id, stale.org_id
    ORDER BY stale.thread_id, event.ordinal
  ) AS rn
FROM unselectable_thread_models AS stale
CROSS JOIN LATERAL (
  VALUES
    ('model_selection_updated'::chat_thread_event_kind, 1),
    ('service_tier_updated'::chat_thread_event_kind, 2)
) AS event (kind, ordinal)
WHERE stale.org_id IS NOT NULL
  AND (event.ordinal = 1 OR stale.clears_service_tier);
--> statement-breakpoint
WITH counts AS (
  SELECT user_id, org_id, count(*) AS cnt
  FROM unselectable_thread_model_events
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
  service_tier, cloud_browser_enabled, created_at
)
SELECT
  event.user_id,
  event.org_id,
  reserved.last_seq_id - counts.cnt + event.rn,
  event.thread_id,
  event.kind,
  event.agent_id,
  NULL,
  NULL,
  false,
  timezone('UTC', now())
FROM unselectable_thread_model_events AS event
JOIN reserved USING (user_id, org_id)
JOIN counts USING (user_id, org_id);
