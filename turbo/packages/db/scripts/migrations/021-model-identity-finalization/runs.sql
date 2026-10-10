-- One bounded atomic statement. $1=cutoff, $2=after UUID (nullable),
-- $3=page size, $4=apply. Never infer execution from today's catalog or org preset.
WITH page AS MATERIALIZED (
  SELECT r.* FROM agent_runs r
  WHERE r.created_at < $1::timestamp AND ($2::uuid IS NULL OR r.id > $2::uuid)
    AND (r.selected_model IN ('okou-1.0','okou-1.0-pro','okou-1.0-max')
      OR (r.model_provider IN ('codex-oauth-token','claude-code-oauth-token')
        AND (r.model_runtime_model IS NULL OR r.model_runtime_provider IS NULL)))
  ORDER BY r.id LIMIT $3
), evidence AS MATERIALIZED (
  SELECT p.*, q.execution_context,
    CASE p.model_provider WHEN 'codex-oauth-token' THEN q.execution_context #>> '{environment,OPENAI_MODEL}'
      WHEN 'claude-code-oauth-token' THEN q.execution_context #>> '{environment,ANTHROPIC_MODEL}' END AS upstream,
    EXISTS (SELECT 1 FROM jsonb_each(COALESCE(q.execution_context->'secretConnectorMetadataMap','{}'::jsonb)) m
      WHERE m.value->>'sourceType' = 'model-provider'
        AND m.value->>'sourceUserId' = p.user_id
        AND m.value->>'sourceId' = p.model_provider_id::text
        AND m.value->>'metadataKey' = p.model_provider) AS bound_account,
    usage.observed_usage_provider, usage.identities,
    -- The retained legacy Pi producer reported its selected alias, not the
    -- upstream preset. A cancelled matching execution can recover that rule
    -- without consulting today's catalog or inventing a usage observation.
    CASE WHEN p.status = 'cancelled' AND p.launch_snapshot->>'framework' = 'pi'
      AND p.selected_model IN ('okou-1.0-pro','okou-1.0-max')
      AND p.model_runtime_provider = 'openrouter-codex'
      AND p.model_runtime_model = '@preset/' || replace(p.selected_model,'.','-')
      THEN p.selected_model END AS cancelled_alias_usage_provider
  FROM page p LEFT JOIN runner_job_queue q ON q.run_id = p.id
  CROSS JOIN LATERAL (
    SELECT CASE WHEN count(DISTINCT provider) = 1 THEN min(provider) END AS observed_usage_provider,
      count(DISTINCT provider) AS identities FROM (
      SELECT provider FROM usage_event WHERE run_id = p.id AND kind = 'model'
      UNION ALL SELECT provider FROM usage_event_hourly_rollup WHERE run_id = p.id AND kind = 'model'
    ) records
  ) usage
), classified AS MATERIALIZED (
  SELECT e.*, CASE
    WHEN model_provider IN ('codex-oauth-token','claude-code-oauth-token') THEN
      CASE WHEN selected_model IS NULL THEN 'uncaptured_selection'
        WHEN model_runtime_model IS NOT NULL OR model_runtime_provider IS NOT NULL THEN 'partial_capture_requires_review'
        WHEN NOT bound_account OR model_provider_account_identity IS NULL THEN 'no_account_bound_execution_evidence'
        WHEN upstream IS NULL OR length(upstream) NOT BETWEEN 1 AND 255 THEN 'no_retained_runtime_evidence'
        WHEN execution_context->'piModelConfig' IS NOT NULL AND
          execution_context #>> '{piModelConfig,model}' IS DISTINCT FROM upstream THEN 'conflicting_runtime_evidence'
        ELSE 'personal_runtime' END
    WHEN model_provider = 'built-in' AND model_runtime_provider IS NOT NULL
      AND model_runtime_model IS NOT NULL AND built_in_model_key_id IS NOT NULL THEN
      CASE WHEN identities > 1 THEN 'conflicting_usage_evidence'
        WHEN observed_usage_provider IS NOT NULL AND COALESCE(model_usage_provider, execution_context->>'modelUsageProvider', observed_usage_provider) <> observed_usage_provider THEN 'conflicting_usage_evidence'
        WHEN selected_model = 'okou-1.0' THEN 'legacy_auto'
        WHEN COALESCE(model_usage_provider, execution_context->>'modelUsageProvider', observed_usage_provider) IS NOT NULL
          THEN 'legacy_alias'
        WHEN cancelled_alias_usage_provider IS NOT NULL THEN 'cancelled_alias'
        ELSE 'no_original_usage_identity' END
    ELSE 'no_complete_managed_execution' END AS reason
  FROM evidence e
), changed AS (
  UPDATE agent_runs r SET
    selected_model = CASE WHEN c.reason IN ('legacy_auto','legacy_alias','cancelled_alias') THEN 'auto' ELSE r.selected_model END,
    model_runtime_provider = CASE WHEN c.reason = 'personal_runtime' THEN c.model_provider ELSE r.model_runtime_provider END,
    model_runtime_model = CASE WHEN c.reason = 'personal_runtime' THEN c.upstream ELSE r.model_runtime_model END,
    model_usage_provider = CASE WHEN c.reason = 'legacy_auto' THEN COALESCE(r.model_usage_provider, c.execution_context->>'modelUsageProvider', c.observed_usage_provider, 'okou-1.0')
      WHEN c.reason IN ('legacy_alias','cancelled_alias') THEN COALESCE(r.model_usage_provider, c.execution_context->>'modelUsageProvider', c.observed_usage_provider, c.cancelled_alias_usage_provider)
      ELSE r.model_usage_provider END,
    model_long_context_min_total_input_tokens = CASE WHEN c.reason IN ('legacy_auto','legacy_alias','cancelled_alias')
      THEN COALESCE(r.model_long_context_min_total_input_tokens, (c.execution_context->>'modelUsageLongContextMinTotalInputTokens')::integer, 272001)
      ELSE r.model_long_context_min_total_input_tokens END
  FROM classified c WHERE $4::boolean AND r.id = c.id
    AND c.reason IN ('personal_runtime','legacy_auto','legacy_alias','cancelled_alias')
    AND r.selected_model IS NOT DISTINCT FROM c.selected_model
    AND r.model_runtime_model IS NOT DISTINCT FROM c.model_runtime_model
    AND r.model_runtime_provider IS NOT DISTINCT FROM c.model_runtime_provider
    AND r.model_provider_id IS NOT DISTINCT FROM c.model_provider_id
    AND r.model_provider_account_identity IS NOT DISTINCT FROM c.model_provider_account_identity
    AND r.model_usage_provider IS NOT DISTINCT FROM c.model_usage_provider
    AND r.model_long_context_min_total_input_tokens IS NOT DISTINCT FROM c.model_long_context_min_total_input_tokens
    AND r.built_in_model_key_id IS NOT DISTINCT FROM c.built_in_model_key_id
  RETURNING r.id
)
SELECT (SELECT count(*)::integer FROM page) AS scanned,
  (SELECT id::text FROM page ORDER BY id DESC LIMIT 1) AS next_cursor,
  (SELECT count(*)::integer FROM changed) AS updated,
  COALESCE((SELECT jsonb_object_agg(reason, n) FROM (SELECT reason, count(*)::integer n FROM classified GROUP BY reason) counts),'{}') AS classifications;
