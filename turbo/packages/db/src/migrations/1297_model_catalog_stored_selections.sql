-- Rewrite mutable stored model selections of retired catalog models to the
-- final active model of their replacement chain (run_model_catalog.replaced_by,
-- followed hop by hop). Re-runnable: every statement only selects rows that
-- still reference a retired model, so a second run changes nothing.
--
-- Touched: org_model_policies.model, org_members_metadata.selected_model and
-- model_settings, agents.selected_model, model_providers.selected_model, and
-- chat thread selections (chat_threads.selected_model and model_settings,
-- with one model_selection_updated event per re-pinned thread, as in 1213).
-- A selection is rewritten only where the replacement has an enabled route of
-- the same provider type; credentials, BYOK, subscription and custom-gateway
-- bindings are never transplanted onto another provider. A chat thread whose
-- legacy provider pin cannot serve the replacement keeps its retired model and
-- pin: the API resolves it along the chain and rejects the incompatible route
-- explicitly instead of silently re-routing it.
--
-- Not touched: history (agent_runs, chat_events including queued inputs,
-- usage and billing, session conversations) and custom-gateway
-- model_mappings. org_plan_entitlements.restricted_built_in_models is a
-- boolean flag, not a model list, so it has nothing to rewrite. Queued inputs
-- are rechecked by the API at dispatch.
CREATE TEMP TABLE model_selection_rewrite ON COMMIT DROP AS
WITH RECURSIVE chain (source, target) AS (
  SELECT model, replaced_by
  FROM run_model_catalog
  WHERE replaced_by IS NOT NULL
  UNION ALL
  SELECT chain.source, next.replaced_by
  FROM chain
  JOIN run_model_catalog AS next
    ON next.model = chain.target AND next.replaced_by IS NOT NULL
)
SELECT chain.source, chain.target
FROM chain
JOIN run_model_catalog AS final
  ON final.model = chain.target AND final.replaced_by IS NULL;
--> statement-breakpoint
ALTER TABLE model_selection_rewrite ADD PRIMARY KEY (source);
--> statement-breakpoint
-- Temp tables have no statistics until analyzed. Without them the planner
-- sorts every chat thread before joining this map of a few rows (measured in
-- MIGRATIONS.md, "Migration 1297 performance evidence").
ANALYZE model_selection_rewrite;
--> statement-breakpoint
-- Effort domain of each replacement: its first enabled Built-in route.
CREATE TEMP TABLE model_selection_rewrite_effort ON COMMIT DROP AS
SELECT DISTINCT ON (route.model)
  route.model AS target,
  route.efforts,
  route.default_effort
FROM model_routes AS route
WHERE route.enabled
  AND route.provider_type = 'built-in'
  AND route.model IN (SELECT target FROM model_selection_rewrite)
ORDER BY route.model, route.priority;
--> statement-breakpoint
-- Serialize with API policy writes (model-policy.service.ts lockPolicyWrites),
-- acquiring the per-organization locks in org_id order.
SELECT pg_advisory_xact_lock(hashtextextended('model-policy:' || affected.org_id, 0))
FROM (
  SELECT DISTINCT policy.org_id
  FROM org_model_policies AS policy
  JOIN model_selection_rewrite AS map ON map.source = policy.model
) AS affected
ORDER BY affected.org_id;
--> statement-breakpoint
-- A retired policy whose route type has no enabled route on the replacement
-- (for example a DeepSeek BYOK policy of deepseek-v4-pro, replaced by
-- gpt-6-luna, or any custom gateway) is dropped instead of transplanting its
-- credentials; the organization can add the replacement with its own route.
-- Of the compatible policies, one per (organization, replacement) survives: an
-- existing replacement policy wins, otherwise the retired default, then the
-- oldest. The legacy is_default flag, still read by older API instances,
-- moves to an existing replacement policy.
CREATE TEMP TABLE model_selection_rewrite_policy ON COMMIT DROP AS
SELECT
  classified.*,
  row_number() OVER (
    PARTITION BY classified.org_id, classified.target, classified.compatible
    ORDER BY classified.is_default DESC, classified.created_at, classified.id
  ) AS rn
FROM (
  SELECT
    policy.id,
    policy.org_id,
    map.target,
    policy.is_default,
    policy.created_at,
    EXISTS (
      SELECT 1
      FROM model_routes AS route
      WHERE route.model = map.target
        AND route.enabled
        AND route.provider_type = policy.default_provider_type
    ) AS compatible,
    EXISTS (
      SELECT 1
      FROM org_model_policies AS existing
      WHERE existing.org_id = policy.org_id AND existing.model = map.target
    ) AS target_exists
  FROM org_model_policies AS policy
  JOIN model_selection_rewrite AS map ON map.source = policy.model
) AS classified;
--> statement-breakpoint
DO $$
DECLARE
  dropped_count bigint;
BEGIN
  SELECT count(*) INTO dropped_count
  FROM model_selection_rewrite_policy
  WHERE NOT compatible;
  RAISE NOTICE 'Stored model selection rewrite: % retired policies have no compatible route on their replacement and are dropped',
    dropped_count;
END
$$;
--> statement-breakpoint
DELETE FROM org_model_policies AS policy
USING model_selection_rewrite_policy AS merged
WHERE policy.id = merged.id
  AND (NOT merged.compatible OR merged.target_exists OR merged.rn > 1);
--> statement-breakpoint
UPDATE org_model_policies AS policy
SET model = merged.target, updated_at = now()
FROM model_selection_rewrite_policy AS merged
WHERE policy.id = merged.id
  AND merged.compatible
  AND NOT merged.target_exists
  AND merged.rn = 1;
--> statement-breakpoint
UPDATE org_model_policies AS policy
SET is_default = true, updated_at = now()
FROM model_selection_rewrite_policy AS merged
WHERE merged.target_exists
  AND merged.is_default
  AND policy.org_id = merged.org_id
  AND policy.model = merged.target
  AND NOT policy.is_default;
--> statement-breakpoint
-- Member effort preferences: copy a retired model's effort to its replacement
-- unless the member already set one there. An effort the replacement's route
-- does not accept becomes that route's default effort; no default means no
-- entry. The retired key stays, as earlier retirements left it.
UPDATE org_members_metadata AS member
SET model_settings = member.model_settings || added.patch, updated_at = now()
FROM (
  SELECT
    converted.org_id,
    converted.user_id,
    jsonb_object_agg(converted.target, jsonb_build_object('effort', converted.effort)) AS patch
  FROM (
    SELECT DISTINCT ON (candidate.org_id, candidate.user_id, map.target)
      candidate.org_id,
      candidate.user_id,
      map.target,
      CASE
        WHEN candidate.model_settings -> map.source ->> 'effort' = ANY(effort.efforts)
          THEN candidate.model_settings -> map.source ->> 'effort'
        ELSE effort.default_effort
      END AS effort
    FROM org_members_metadata AS candidate
    JOIN model_selection_rewrite AS map
      ON (candidate.model_settings -> map.source) ? 'effort'
    JOIN model_selection_rewrite_effort AS effort ON effort.target = map.target
    WHERE NOT candidate.model_settings ? map.target
    ORDER BY
      candidate.org_id,
      candidate.user_id,
      map.target,
      (candidate.selected_model IS NOT DISTINCT FROM map.source) DESC,
      map.source
  ) AS converted
  WHERE converted.effort IS NOT NULL
  GROUP BY converted.org_id, converted.user_id
) AS added
WHERE member.org_id = added.org_id AND member.user_id = added.user_id;
--> statement-breakpoint
UPDATE org_members_metadata AS member
SET selected_model = map.target, updated_at = now()
FROM model_selection_rewrite AS map
WHERE member.selected_model = map.source;
--> statement-breakpoint
-- An agent pinned to a provider connection keeps its selection unless that
-- provider type serves the replacement; the API resolves and rejects it.
UPDATE agents AS agent
SET selected_model = map.target, updated_at = now()
FROM model_selection_rewrite AS map
WHERE agent.selected_model = map.source
  AND (
    agent.model_provider_id IS NULL
    OR EXISTS (
      SELECT 1
      FROM model_providers AS provider
      JOIN model_routes AS route
        ON route.model = map.target
       AND route.enabled
       AND route.provider_type = provider.type
      WHERE provider.id = agent.model_provider_id
    )
  );
--> statement-breakpoint
UPDATE model_providers AS provider
SET selected_model = map.target, updated_at = now()
FROM model_selection_rewrite AS map
WHERE provider.selected_model = map.source
  AND EXISTS (
    SELECT 1
    FROM model_routes AS route
    WHERE route.model = map.target
      AND route.enabled
      AND route.provider_type = provider.type
  );
--> statement-breakpoint
-- Chat threads. chat_threads has no selected_model index: scan it once, like
-- 1213. The effective legacy pin is model_provider_type, or the type of the
-- pinned model_providers row. No pin, or a pin type the replacement serves,
-- is compatible; the pin columns are kept as they are. The organization comes
-- from the thread's agent; agentless threads have no event stream.
CREATE TEMP TABLE model_selection_rewrite_threads ON COMMIT DROP AS
SELECT
  thread.id AS thread_id,
  thread.user_id,
  agent.org_id,
  thread.agent_id,
  map.target,
  CASE
    WHEN thread.model_settings ? map.target THEN NULL
    WHEN (thread.model_settings -> map.source ->> 'effort') = ANY(route.efforts)
      THEN thread.model_settings -> map.source ->> 'effort'
    WHEN thread.model_settings -> map.source ? 'effort' THEN route.default_effort
  END AS effort,
  row_number() OVER (
    PARTITION BY thread.user_id, agent.org_id
    ORDER BY thread.id
  ) AS rn
FROM chat_threads AS thread
JOIN model_selection_rewrite AS map ON map.source = thread.selected_model
LEFT JOIN agents AS agent ON agent.id = thread.agent_id
LEFT JOIN model_providers AS provider ON provider.id = thread.model_provider_id
CROSS JOIN LATERAL (
  SELECT candidate.efforts, candidate.default_effort
  FROM model_routes AS candidate
  WHERE candidate.model = map.target
    AND candidate.enabled
    AND candidate.provider_type = CASE
      WHEN thread.model_provider_type IS NULL AND thread.model_provider_id IS NULL
        THEN 'built-in'
      ELSE coalesce(thread.model_provider_type, provider.type)
    END
  ORDER BY candidate.priority
  LIMIT 1
) AS route;
--> statement-breakpoint
UPDATE chat_threads AS thread
SET
  selected_model = moved.target,
  model_settings = CASE
    WHEN moved.effort IS NULL THEN thread.model_settings
    ELSE thread.model_settings
      || jsonb_build_object(moved.target, jsonb_build_object('effort', moved.effort))
  END,
  updated_at = now()
FROM model_selection_rewrite_threads AS moved
WHERE thread.id = moved.thread_id;
--> statement-breakpoint
-- Reserve one contiguous seq_id range per (user_id, org_id) stream, in key
-- order, and append one model_selection_updated event per re-pinned thread.
WITH counts AS (
  SELECT user_id, org_id, count(*) AS cnt
  FROM model_selection_rewrite_threads
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
  model_settings_patch, cloud_browser_enabled, created_at
)
SELECT
  moved.user_id,
  moved.org_id,
  reserved.last_seq_id - counts.cnt + moved.rn,
  moved.thread_id,
  'model_selection_updated',
  moved.agent_id,
  moved.target,
  CASE
    WHEN moved.effort IS NULL THEN NULL
    ELSE jsonb_build_object('model', moved.target, 'effort', moved.effort)
  END,
  false,
  timezone('UTC', now())
FROM model_selection_rewrite_threads AS moved
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
      WHERE model IN (SELECT source FROM model_selection_rewrite)
    UNION ALL
    SELECT 1 FROM org_members_metadata
      WHERE selected_model IN (SELECT source FROM model_selection_rewrite)
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
    RAISE EXCEPTION 'Stored model selection rewrite left % references and % organizations with multiple defaults',
      remaining_count, multi_default_count;
  END IF;
END
$$;
