-- Read-only release-three census. Run against an authorized database snapshot.
-- Counts describe relational coverage, not installed consumers or blob resume.
SET default_transaction_read_only = on;
SET statement_timeout = '30s';
SELECT 'threads' AS surface,
  count(*) FILTER (WHERE selected_model IS NULL) AS nullable_auto,
  count(*) FILTER (WHERE selected_model IN ('okou-1.0', 'okou-1.0-pro', 'okou-1.0-max')) AS legacy_auto,
  count(*) FILTER (WHERE selected_model = '') AS empty_selection,
  count(*) FILTER (WHERE jsonb_path_exists(model_settings, '$.keyvalue() ? (@.key == "auto" || @.key == "okou-1.0" || @.key == "okou-1.0-pro" || @.key == "okou-1.0-max" || @.key starts with "@preset/")')) AS incompatible_settings
FROM chat_threads;
SELECT 'members' AS surface,
  count(*) FILTER (WHERE selected_model IS NULL) AS nullable_auto,
  count(*) FILTER (WHERE selected_model IN ('okou-1.0', 'okou-1.0-pro', 'okou-1.0-max')) AS legacy_auto,
  count(*) FILTER (WHERE selected_model = '') AS empty_selection,
  count(*) FILTER (WHERE jsonb_path_exists(model_settings, '$.keyvalue() ? (@.key == "auto" || @.key == "okou-1.0" || @.key == "okou-1.0-pro" || @.key == "okou-1.0-max" || @.key starts with "@preset/")')) AS incompatible_settings
FROM org_members_metadata;
SELECT kind, count(*) AS events,
  count(*) FILTER (WHERE selected_model IS NULL) AS omitted_selection,
  count(*) FILTER (WHERE selected_model IN ('okou-1.0', 'okou-1.0-pro', 'okou-1.0-max')) AS legacy_selection
FROM chat_thread_events GROUP BY kind ORDER BY kind;
SELECT count(*) FILTER (WHERE model_selection IS NULL) AS uncaptured_decisions,
  count(*) FILTER (WHERE model_selection ->> 'selectedModel' = 'okou-1.0') AS legacy_captured_decisions,
  count(*) FILTER (WHERE jsonb_path_exists(payload, '$.userMessage.parts[*] ? (@.type == "model" && @.selectedModel == "okou-1.0")')) AS legacy_annotations
FROM chat_events;
SELECT count(*) AS unconsumed_legacy_decisions
FROM chat_events AS input
WHERE input.run_id IS NULL
  AND input.event_type IN ('input.prompt', 'input.automation', 'input.budget')
  AND input.model_selection ->> 'selectedModel' = 'okou-1.0'
  AND NOT EXISTS (SELECT 1 FROM chat_events AS revoke WHERE revoke.revokes_event_id = input.id);
SELECT selected_model, status, count(*) AS runs,
  count(*) FILTER (WHERE NULLIF(model_runtime_provider, '') IS NOT NULL AND NULLIF(model_runtime_model, '') IS NOT NULL AND built_in_model_key_id IS NOT NULL) AS captured_builtin_bindings
FROM agent_runs WHERE selected_model IN ('auto', 'okou-1.0')
GROUP BY selected_model, status ORDER BY selected_model, status;
SELECT count(*) AS queued_jobs,
  count(*) FILTER (WHERE run.selected_model = 'okou-1.0') AS legacy_jobs
FROM runner_job_queue AS job JOIN agent_runs AS run ON run.id = job.run_id;
SELECT run.selected_model, conversation.cli_agent_type, count(*) AS retained_conversations,
  count(*) FILTER (WHERE conversation.cli_agent_session_history_hash IS NOT NULL) AS blob_references,
  count(*) FILTER (WHERE conversation.cli_agent_session_history IS NOT NULL) AS inline_histories,
  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM agent_sessions AS session WHERE session.conversation_id = conversation.id)) AS resumable_session_references
FROM conversations AS conversation JOIN agent_runs AS run ON run.id = conversation.run_id
WHERE run.selected_model IN ('auto', 'okou-1.0')
GROUP BY run.selected_model, conversation.cli_agent_type;
SELECT count(*) AS thread_snapshot_heads,
  count(*) FILTER (WHERE object_key IS NULL) AS absent_objects
FROM chat_thread_snapshots;
SELECT archive_schema_version, count(*) AS event_snapshot_heads,
  count(*) FILTER (WHERE object_key IS NULL) AS absent_objects
FROM chat_event_snapshots GROUP BY archive_schema_version;
