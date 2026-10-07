-- Auto is stored only as NULL. A thread or member selection is NULL or a
-- model users can pick: an active run_model_catalog model with an enabled
-- personal subscription route. Every stored id that identifies another active
-- catalog model returns to NULL: okou-1.0 (the Auto run model, which stays the
-- internal run model id) and Built-in-only models such as deepseek-v4.1-flash.
-- Ids are identified as the API does (catalogModelForSelectedId): a trimmed
-- catalog model id, or else the upstream id of routes of exactly one model.
-- A retired model whose replacement chain ends at such a model (okou-1.0-pro)
-- is no longer selectable either. Retired models replaced by a selectable
-- model and ids the API cannot resolve are not touched; 1335 already returned
-- the unresolvable ones to Auto.
CREATE TEMP TABLE auto_selection_ids ON COMMIT DROP AS
WITH RECURSIVE auto_models AS (
  SELECT catalog.model
  FROM run_model_catalog AS catalog
  WHERE catalog.replaced_by IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM model_routes AS route
      WHERE route.model = catalog.model
        AND route.enabled
        AND route.subscription_type IS NOT NULL
    )
  UNION
  SELECT retired.model
  FROM run_model_catalog AS retired
  JOIN auto_models ON retired.replaced_by = auto_models.model
)
SELECT model AS id FROM auto_models
UNION
SELECT route.upstream_model
FROM model_routes AS route
WHERE NOT EXISTS (
  SELECT 1 FROM run_model_catalog AS catalog
  WHERE catalog.model = route.upstream_model
)
GROUP BY route.upstream_model
HAVING count(DISTINCT route.model) = 1
  AND min(route.model) IN (SELECT model FROM auto_models);
--> statement-breakpoint
-- Chat threads return to Auto as if the owner had picked Auto: the snapshot
-- changes and the owner's thread event stream gets one model_selection_updated
-- event with a NULL model. A stored Codex service tier is cleared with its
-- service_tier_updated event (Auto has no Fast tier), as the model selection
-- route does for Auto. model_settings keeps its per-model entries.
--
-- chat_threads has no selected_model index: scan it once, like 1335. The
-- organization comes from the thread's agent; agentless threads have no event
-- stream.
CREATE TEMP TABLE auto_selection_threads ON COMMIT DROP AS
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
  AND btrim(thread.selected_model) IN (SELECT id FROM auto_selection_ids);
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
  FROM auto_selection_threads AS stale
  WHERE thread.id = stale.thread_id
    AND thread.selected_model = stale.source
  RETURNING thread.id
)
DELETE FROM auto_selection_threads AS stale
WHERE NOT EXISTS (
  SELECT 1 FROM cleared WHERE cleared.id = stale.thread_id
);
--> statement-breakpoint
-- Events in the order the selection route writes them: the model event, then
-- the service tier event. Reserve one contiguous seq_id range per
-- (user_id, org_id) stream, in key order, as 1335 does.
CREATE TEMP TABLE auto_selection_thread_events ON COMMIT DROP AS
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
FROM auto_selection_threads AS stale
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
  FROM auto_selection_thread_events
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
FROM auto_selection_thread_events AS event
JOIN reserved USING (user_id, org_id)
JOIN counts USING (user_id, org_id);
--> statement-breakpoint
-- Member default selections have no event stream. A NULL model clears its
-- tier too, as the preference route writes Auto: the tier only qualifies a
-- model. model_settings keeps its per-model entries.
UPDATE org_members_metadata
SET
  selected_model = NULL,
  service_tier = NULL,
  updated_at = timezone('UTC', now())
WHERE selected_model IS NOT NULL
  AND btrim(selected_model) IN (SELECT id FROM auto_selection_ids);
