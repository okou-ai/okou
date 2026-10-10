-- $1=cutoff, $2=after UUID (nullable), $3=page size, $4=apply.
-- SQL NULL model_selection stays uncaptured. Live unconsumed decisions cannot be reinterpreted.
WITH page AS MATERIALIZED (
  SELECT e.* FROM chat_events e
  WHERE created_at < $1::timestamp AND ($2::uuid IS NULL OR id > $2::uuid)
    AND (model_selection->>'selectedModel' IN ('okou-1.0','okou-1.0-pro','okou-1.0-max')
      OR jsonb_path_exists(payload, '$.userMessage.parts[*] ? (@.type == "model" && (@.selectedModel == "okou-1.0" || @.selectedModel == "okou-1.0-pro" || @.selectedModel == "okou-1.0-max"))'))
  ORDER BY id LIMIT $3
), classified AS MATERIALIZED (
  SELECT p.*, CASE WHEN p.event_type IN ('input.prompt','input.automation','input.budget')
    AND p.run_id IS NULL AND NOT EXISTS (SELECT 1 FROM chat_events revoke WHERE revoke.revokes_event_id = p.id)
    THEN 'unconsumed_decision' ELSE 'historical_decision' END AS reason FROM page p
), changed AS (
  UPDATE chat_events e SET
    model_selection = CASE WHEN e.model_selection->>'selectedModel' IN ('okou-1.0','okou-1.0-pro','okou-1.0-max')
      THEN e.model_selection || '{"selectedModel":"auto","reasoningEffort":null,"codexServiceTier":null}'::jsonb ELSE e.model_selection END,
    payload = CASE WHEN jsonb_typeof(e.payload #> '{userMessage,parts}') = 'array' THEN jsonb_set(e.payload, '{userMessage,parts}',
      (SELECT jsonb_agg(CASE WHEN part->>'type' = 'model' AND part->>'selectedModel' IN ('okou-1.0','okou-1.0-pro','okou-1.0-max')
        THEN (part - 'serviceTier') || '{"selectedModel":"auto"}'::jsonb ELSE part END ORDER BY ordinal)
       FROM jsonb_array_elements(e.payload #> '{userMessage,parts}') WITH ORDINALITY parts(part,ordinal))) ELSE e.payload END
  FROM classified c WHERE $4::boolean AND e.id = c.id AND c.reason = 'historical_decision'
    AND e.payload IS NOT DISTINCT FROM c.payload AND e.model_selection IS NOT DISTINCT FROM c.model_selection
    AND e.run_id IS NOT DISTINCT FROM c.run_id
  RETURNING e.id
)
SELECT (SELECT count(*)::integer FROM page) AS scanned,
  (SELECT id::text FROM page ORDER BY id DESC LIMIT 1) AS next_cursor,
  (SELECT count(*)::integer FROM changed) AS updated,
  COALESCE((SELECT jsonb_object_agg(reason, n) FROM (SELECT reason, count(*)::integer n FROM classified GROUP BY reason) counts),'{}') AS classifications;
