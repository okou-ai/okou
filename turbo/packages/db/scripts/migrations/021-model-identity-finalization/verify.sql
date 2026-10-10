-- Read-only reconciliation. Counts are a point-in-time sample, not drain evidence.
SELECT jsonb_build_object(
  'legacy_run_selected', (SELECT count(*) FROM agent_runs WHERE selected_model IN ('okou-1.0','okou-1.0-pro','okou-1.0-max')),
  'uncaptured_runs_by_lifecycle', (SELECT jsonb_object_agg(status,n) FROM (SELECT status,count(*) n FROM agent_runs WHERE selected_model IS NULL GROUP BY status) s),
  'personal_runtime_gaps_by_lifecycle', (SELECT jsonb_object_agg(status,n) FROM (SELECT status,count(*) n FROM agent_runs WHERE model_provider IN ('codex-oauth-token','claude-code-oauth-token') AND (model_runtime_model IS NULL OR model_runtime_provider IS NULL) GROUP BY status) s),
  'canonical_catalog', (SELECT count(*) FROM run_model_catalog WHERE model = 'auto' AND replaced_by IS NULL),
  'canonical_routes', (SELECT count(*) FROM model_routes WHERE model = 'auto' AND provider_type = 'built-in' AND enabled),
  'legacy_alias_relationships', (SELECT count(*) FROM run_model_catalog WHERE replaced_by = 'okou-1.0' OR (model IN ('okou-1.0-pro','okou-1.0-max') AND replaced_by IS DISTINCT FROM 'auto')),
  'legacy_captured_decisions', (SELECT count(*) FROM chat_events WHERE model_selection->>'selectedModel' IN ('okou-1.0','okou-1.0-pro','okou-1.0-max')),
  'legacy_inline_annotations', (SELECT count(*) FROM chat_events WHERE jsonb_path_exists(payload, '$.userMessage.parts[*] ? (@.type == "model" && (@.selectedModel == "okou-1.0" || @.selectedModel == "okou-1.0-pro" || @.selectedModel == "okou-1.0-max"))')),
  'new_personal_runtime_gaps', (SELECT count(*) FROM agent_runs WHERE created_at >= $1::timestamp AND launch_snapshot IS NOT NULL AND model_provider IN ('codex-oauth-token','claude-code-oauth-token') AND status IN ('pending','running','completed') AND (model_runtime_model IS NULL OR model_runtime_provider IS NULL)),
  'raw_usage_identity_mismatches', (SELECT count(*) FROM usage_event u JOIN agent_runs r ON r.id = u.run_id WHERE u.kind = 'model' AND r.model_provider = 'built-in' AND r.model_usage_provider IS NOT NULL AND u.provider <> r.model_usage_provider),
  'compacted_usage_identity_mismatches', (SELECT count(*) FROM usage_event_hourly_rollup u JOIN agent_runs r ON r.id = u.run_id WHERE u.kind = 'model' AND r.model_provider = 'built-in' AND r.model_usage_provider IS NOT NULL AND u.provider <> r.model_usage_provider),
  'personal_billable_model_rows', (SELECT count(*) FROM usage_event u JOIN agent_runs r ON r.id = u.run_id WHERE u.kind = 'model' AND r.model_provider IN ('codex-oauth-token','claude-code-oauth-token')),
  'retained_event_export_sources', (SELECT count(*) FROM user_export_entries WHERE source_key LIKE 'chat-events/%'),
  'thread_snapshot_heads', (SELECT count(*) FROM chat_thread_snapshots),
  'event_snapshot_heads', (SELECT count(*) FROM chat_event_snapshots),
  'unsupported_event_snapshot_versions', (SELECT count(*) FROM chat_event_snapshots WHERE archive_schema_version <> 8)
) AS report;
