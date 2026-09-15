-- One-release retirement: GPT 5.5 has no recent runs or live defaults.
-- Clear mutable selections so existing member/workspace default resolution applies.
-- Completed runs, chat events, usage records, and pricing remain historical data.
DO $$
DECLARE
  retired_models text[] := ARRAY['gpt-5.5', 'openai/gpt-5.5'];
  default_count bigint;
  member_count bigint;
  agent_count bigint;
  provider_count bigint;
  policy_count bigint;
  thread_count bigint;
  thread_settings_count bigint;
  member_settings_count bigint;
  surface_count bigint;
  remaining_count bigint;
BEGIN
  SELECT count(*) INTO default_count
  FROM org_model_policies
  WHERE model = ANY(retired_models) AND is_default;

  SELECT count(*) INTO member_count
  FROM org_members_metadata
  WHERE selected_model = ANY(retired_models);

  SELECT count(*) INTO agent_count
  FROM agents
  WHERE selected_model = ANY(retired_models);

  SELECT count(*) INTO provider_count
  FROM model_providers
  WHERE selected_model = ANY(retired_models);

  RAISE NOTICE 'GPT 5.5 retirement preflight: defaults=%, members=%, agents=%, providers=%',
    default_count, member_count, agent_count, provider_count;

  IF default_count + member_count + agent_count + provider_count <> 0 THEN
    RAISE EXCEPTION 'GPT 5.5 retirement preflight changed; resolve live defaults and preferences before retrying';
  END IF;

  DELETE FROM org_model_policies
  WHERE model = ANY(retired_models);
  GET DIAGNOSTICS policy_count = ROW_COUNT;

  UPDATE chat_threads
  SET selected_model = NULL,
      model_provider_id = NULL,
      model_provider_type = NULL,
      model_provider_credential_scope = NULL,
      reasoning_effort = NULL,
      codex_service_tier = NULL,
      model_settings = model_settings - retired_models
  WHERE selected_model = ANY(retired_models);
  GET DIAGNOSTICS thread_count = ROW_COUNT;

  -- Remove only the retired model's saved effort; preserve other model settings.
  UPDATE chat_threads
  SET model_settings = model_settings - retired_models
  WHERE model_settings ?| retired_models;
  GET DIAGNOSTICS thread_settings_count = ROW_COUNT;

  UPDATE org_members_metadata
  SET model_settings = model_settings - retired_models
  WHERE model_settings ?| retired_models;
  GET DIAGNOSTICS member_settings_count = ROW_COUNT;

  -- Credentials and unrelated mappings remain owned by the existing connection.
  UPDATE model_provider_surfaces AS surface
  SET model_mappings = (
    SELECT coalesce(jsonb_object_agg(mapping.key, mapping.value), '{}'::jsonb)
    FROM jsonb_each_text(surface.model_mappings) AS mapping
    WHERE mapping.key <> ALL(retired_models)
      AND lower(btrim(mapping.value)) <> ALL(retired_models)
  )
  WHERE model_mappings ?| retired_models
    OR EXISTS (
      SELECT 1 FROM jsonb_each_text(surface.model_mappings) AS mapping
      WHERE lower(btrim(mapping.value)) = ANY(retired_models)
    );
  GET DIAGNOSTICS surface_count = ROW_COUNT;

  SELECT count(*) INTO remaining_count
  FROM (
    SELECT 1 FROM org_model_policies WHERE model = ANY(retired_models)
    UNION ALL
    SELECT 1 FROM chat_threads
      WHERE selected_model = ANY(retired_models) OR model_settings ?| retired_models
    UNION ALL
    SELECT 1 FROM org_members_metadata
      WHERE selected_model = ANY(retired_models) OR model_settings ?| retired_models
    UNION ALL
    SELECT 1 FROM agents WHERE selected_model = ANY(retired_models)
    UNION ALL
    SELECT 1 FROM model_providers WHERE selected_model = ANY(retired_models)
    UNION ALL
    SELECT 1 FROM model_provider_surfaces AS surface
      WHERE model_mappings ?| retired_models
        OR EXISTS (
          SELECT 1 FROM jsonb_each_text(surface.model_mappings) AS mapping
          WHERE lower(btrim(mapping.value)) = ANY(retired_models)
        )
  ) AS remaining;

  IF remaining_count <> 0 THEN
    RAISE EXCEPTION 'GPT 5.5 retirement left % live configuration references', remaining_count;
  END IF;

  RAISE NOTICE 'GPT 5.5 retirement: policies=%, thread_pins=%, other_thread_settings=%, member_settings=%, surfaces=%, remaining=%',
    policy_count, thread_count, thread_settings_count, member_settings_count,
    surface_count, remaining_count;
END
$$;
