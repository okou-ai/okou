-- Release-three contraction. Do not ship until the serving/rollback, installed
-- consumer and retained-history gates recorded in the owning PR are closed.
-- A captured legacy input must finish admission under its original semantics.
SET LOCAL statement_timeout = '120s';
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM chat_events AS input
    WHERE input.run_id IS NULL
      AND input.event_type IN ('input.prompt', 'input.automation', 'input.budget')
      AND input.model_selection ->> 'selectedModel' = 'okou-1.0'
      AND NOT EXISTS (
        SELECT 1 FROM chat_events AS revoke WHERE revoke.revokes_event_id = input.id
      )
  ) THEN
    RAISE EXCEPTION 'Unconsumed legacy model decisions must drain before contraction';
  END IF;
END $$;
--> statement-breakpoint
-- 1298 replaced these two preference aliases with Auto. This removes only
-- proven Auto/preset effort keys, not arbitrary retired personal preferences.
CREATE FUNCTION pg_temp.explicit_model_settings(settings jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb)
  FROM jsonb_each(settings)
  WHERE key NOT IN ('auto', 'okou-1.0', 'okou-1.0-pro', 'okou-1.0-max')
    AND key NOT LIKE '@preset/%'
$$;
--> statement-breakpoint
CREATE FUNCTION pg_temp.canonical_model_annotation(payload jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE WHEN jsonb_path_exists(payload,
    '$.userMessage.parts[*] ? (@.type == "model" && @.selectedModel == "okou-1.0")')
  THEN jsonb_set(payload, '{userMessage,parts}', (
    SELECT jsonb_agg(CASE
      WHEN part ->> 'type' = 'model' AND part ->> 'selectedModel' = 'okou-1.0'
      THEN (part - 'serviceTier') || '{"selectedModel":"auto"}'::jsonb
      ELSE part END ORDER BY ordinal)
    FROM jsonb_array_elements(payload #> '{userMessage,parts}') WITH ORDINALITY AS parts(part, ordinal)
  )) ELSE payload END
$$;
--> statement-breakpoint
-- Keyset pages bound each write set. The migration transaction owns rollback;
-- SET expressions and predicates inspect the current row, not a stale copy.
DO $$
DECLARE cursor_id uuid; next_id uuid;
BEGIN
  LOOP
    SELECT max_page.id INTO next_id FROM (
      SELECT id FROM chat_threads
      WHERE cursor_id IS NULL OR id > cursor_id ORDER BY id LIMIT 1000
    ) max_page ORDER BY id DESC LIMIT 1;
    EXIT WHEN next_id IS NULL;
    UPDATE chat_threads SET
      selected_model = CASE WHEN selected_model IS NULL OR selected_model IN
        ('okou-1.0', 'okou-1.0-pro', 'okou-1.0-max') THEN 'auto' ELSE selected_model END,
      codex_service_tier = CASE WHEN selected_model IS NULL OR selected_model IN
        ('auto', 'okou-1.0', 'okou-1.0-pro', 'okou-1.0-max') THEN NULL ELSE codex_service_tier END,
      model_settings = pg_temp.explicit_model_settings(model_settings)
    WHERE (cursor_id IS NULL OR id > cursor_id) AND id <= next_id
      AND (selected_model IS NULL OR selected_model IN ('okou-1.0', 'okou-1.0-pro', 'okou-1.0-max')
        OR (selected_model = 'auto' AND codex_service_tier IS NOT NULL)
        OR model_settings IS DISTINCT FROM pg_temp.explicit_model_settings(model_settings));
    cursor_id := next_id;
  END LOOP;
END $$;
--> statement-breakpoint
DO $$
DECLARE cursor_org text; cursor_user text; next_org text; next_user text;
BEGIN
  LOOP
    SELECT page.org_id, page.user_id INTO next_org, next_user FROM (
      SELECT org_id, user_id FROM org_members_metadata
      WHERE cursor_org IS NULL OR (org_id, user_id) > (cursor_org, cursor_user)
      ORDER BY org_id, user_id LIMIT 1000
    ) page ORDER BY org_id DESC, user_id DESC LIMIT 1;
    EXIT WHEN next_org IS NULL;
    UPDATE org_members_metadata SET
      selected_model = CASE WHEN selected_model IS NULL OR selected_model IN
        ('okou-1.0', 'okou-1.0-pro', 'okou-1.0-max') THEN 'auto' ELSE selected_model END,
      service_tier = CASE WHEN selected_model IS NULL OR selected_model IN
        ('auto', 'okou-1.0', 'okou-1.0-pro', 'okou-1.0-max') THEN NULL ELSE service_tier END,
      model_settings = pg_temp.explicit_model_settings(model_settings)
    WHERE (cursor_org IS NULL OR (org_id, user_id) > (cursor_org, cursor_user))
      AND (org_id, user_id) <= (next_org, next_user)
      AND (selected_model IS NULL OR selected_model IN ('okou-1.0', 'okou-1.0-pro', 'okou-1.0-max')
        OR (selected_model = 'auto' AND service_tier IS NOT NULL)
        OR model_settings IS DISTINCT FROM pg_temp.explicit_model_settings(model_settings));
    cursor_org := next_org; cursor_user := next_user;
  END LOOP;
END $$;
--> statement-breakpoint
DO $$
DECLARE cursor_id uuid; next_id uuid;
BEGIN
  LOOP
    SELECT page.id INTO next_id FROM (
      SELECT id FROM chat_thread_events WHERE cursor_id IS NULL OR id > cursor_id
      ORDER BY id LIMIT 1000
    ) page ORDER BY id DESC LIMIT 1;
    EXIT WHEN next_id IS NULL;
    UPDATE chat_thread_events SET
      selected_model = CASE
        WHEN kind IN ('created', 'model_selection_updated') AND (selected_model IS NULL OR selected_model IN
          ('okou-1.0', 'okou-1.0-pro', 'okou-1.0-max')) THEN 'auto'
        WHEN selected_model IN ('okou-1.0', 'okou-1.0-pro', 'okou-1.0-max') THEN 'auto'
        ELSE selected_model END,
      model_settings = pg_temp.explicit_model_settings(model_settings),
      model_settings_patch = CASE
        WHEN model_settings_patch ->> 'model' IN ('auto', 'okou-1.0', 'okou-1.0-pro', 'okou-1.0-max')
          OR model_settings_patch ->> 'model' LIKE '@preset/%' THEN NULL
        ELSE model_settings_patch END
    WHERE (cursor_id IS NULL OR id > cursor_id) AND id <= next_id
      AND ((kind IN ('created', 'model_selection_updated') AND selected_model IS NULL)
        OR selected_model IN ('okou-1.0', 'okou-1.0-pro', 'okou-1.0-max')
        OR model_settings IS DISTINCT FROM pg_temp.explicit_model_settings(model_settings)
        OR model_settings_patch ->> 'model' IN ('auto', 'okou-1.0', 'okou-1.0-pro', 'okou-1.0-max')
        OR model_settings_patch ->> 'model' LIKE '@preset/%');
    cursor_id := next_id;
  END LOOP;
END $$;
--> statement-breakpoint
DO $$
DECLARE cursor_id uuid; next_id uuid;
BEGIN
  LOOP
    SELECT page.id INTO next_id FROM (
      SELECT id FROM chat_events WHERE cursor_id IS NULL OR id > cursor_id
      ORDER BY id LIMIT 1000
    ) page ORDER BY id DESC LIMIT 1;
    EXIT WHEN next_id IS NULL;
    UPDATE chat_events SET
      model_selection = CASE WHEN model_selection ->> 'selectedModel' = 'okou-1.0'
        THEN model_selection || '{"selectedModel":"auto","reasoningEffort":null,"codexServiceTier":null}'::jsonb
        ELSE model_selection END,
      payload = pg_temp.canonical_model_annotation(payload)
    WHERE (cursor_id IS NULL OR id > cursor_id) AND id <= next_id
      AND (model_selection ->> 'selectedModel' = 'okou-1.0'
        OR payload IS DISTINCT FROM pg_temp.canonical_model_annotation(payload));
    cursor_id := next_id;
  END LOOP;
END $$;
--> statement-breakpoint
-- Runtime bindings, serialized execution configurations and native histories
-- remain immutable. An alias alone cannot justify historical runtime conversion.
DROP FUNCTION pg_temp.explicit_model_settings(jsonb);
--> statement-breakpoint
DROP FUNCTION pg_temp.canonical_model_annotation(jsonb);
--> statement-breakpoint
ALTER TABLE "chat_threads" ALTER COLUMN "selected_model" SET DEFAULT 'auto';--> statement-breakpoint
ALTER TABLE "chat_threads" ALTER COLUMN "selected_model" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "org_members_metadata" ALTER COLUMN "selected_model" SET DEFAULT 'auto';--> statement-breakpoint
ALTER TABLE "org_members_metadata" ALTER COLUMN "selected_model" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_selected_model_check" CHECK ("agent_runs"."selected_model" IS NULL OR char_length("agent_runs"."selected_model") > 0);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_executable_builtin_capture_check" CHECK (NOT (
          "agent_runs"."model_provider" = 'built-in' AND
          "agent_runs"."launch_snapshot" IS NOT NULL AND
          "agent_runs"."status" IN ('pending', 'running')
        ) OR (
          "agent_runs"."selected_model" IS NOT NULL AND
          "agent_runs"."model_runtime_provider" IS NOT NULL AND
          char_length("agent_runs"."model_runtime_provider") > 0 AND
          "agent_runs"."model_runtime_model" IS NOT NULL AND
          char_length("agent_runs"."model_runtime_model") > 0 AND
          "agent_runs"."built_in_model_key_id" IS NOT NULL
        ));--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_model_selection_check" CHECK ("chat_events"."model_selection" IS NULL OR COALESCE((
          jsonb_typeof("chat_events"."model_selection") = 'object' AND
          jsonb_typeof("chat_events"."model_selection" -> 'selectedModel') = 'string' AND
          char_length("chat_events"."model_selection" ->> 'selectedModel') > 0
        ), false));--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_model_annotation_check" CHECK (NOT jsonb_path_exists("chat_events"."payload", '$.userMessage.parts[*] ? (@.type == "model" && (!exists(@.selectedModel) || @.selectedModel.type() != "string" || @.selectedModel == ""))'));--> statement-breakpoint
ALTER TABLE "chat_thread_events" ADD CONSTRAINT "chat_thread_events_selected_model_check" CHECK ("chat_thread_events"."selected_model" IS NULL OR char_length("chat_thread_events"."selected_model") > 0);--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_selected_model_check" CHECK (char_length("chat_threads"."selected_model") > 0);--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_explicit_model_settings_check" CHECK (jsonb_typeof("chat_threads"."model_settings") = 'object' AND NOT jsonb_path_exists("chat_threads"."model_settings", '$.keyvalue() ? (@.key == "auto" || @.key == "okou-1.0" || @.key == "okou-1.0-pro" || @.key == "okou-1.0-max" || @.key starts with "@preset/")'));--> statement-breakpoint
ALTER TABLE "org_members_metadata" ADD CONSTRAINT "org_members_metadata_selected_model_check" CHECK (char_length("org_members_metadata"."selected_model") > 0);--> statement-breakpoint
ALTER TABLE "org_members_metadata" ADD CONSTRAINT "org_members_metadata_explicit_model_settings_check" CHECK (jsonb_typeof("org_members_metadata"."model_settings") = 'object' AND NOT jsonb_path_exists("org_members_metadata"."model_settings", '$.keyvalue() ? (@.key == "auto" || @.key == "okou-1.0" || @.key == "okou-1.0-pro" || @.key == "okou-1.0-max" || @.key starts with "@preset/")'));