ALTER TABLE "chat_agent_run_context" ALTER COLUMN "source_agent_id" DROP NOT NULL;
--> statement-breakpoint
-- okou:non-transactional
-- Each command retains the original fresh snapshot and lock order. In
-- particular, finish the parent DELETE's FK actions before reserving the
-- shared user/org stream, so a blocked child cannot stall another thread.
CREATE OR REPLACE FUNCTION public.delete_chat_thread_content(
  p_thread_id uuid,
  p_user_id text,
  p_org_id text,
  p_event_id text,
  p_automation_updated_at timestamp without time zone
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
PARALLEL UNSAFE
AS $chat_thread_deletion$
DECLARE
  authorized_id uuid;
  owned_thread record;
  active_runs jsonb;
  disabled_automations jsonb;
  deleted_id uuid;
BEGIN
  SELECT thread.id INTO authorized_id
  FROM public.chat_threads AS thread
  WHERE thread.id = p_thread_id AND thread.user_id = p_user_id
    AND thread.org_id = p_org_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('deleted', false, 'activeRuns', '[]'::jsonb,
      'disabledAutomations', '[]'::jsonb);
  END IF;

  PERFORM run.id FROM public.agent_runs AS run
  WHERE run.chat_thread_id = p_thread_id
  ORDER BY run.id FOR NO KEY UPDATE;
  PERFORM sequence.chat_thread_id FROM public.chat_event_sequences AS sequence
  WHERE sequence.chat_thread_id = p_thread_id FOR UPDATE;

  SELECT thread.id INTO owned_thread
  FROM public.chat_threads AS thread
  WHERE thread.id = p_thread_id AND thread.user_id = p_user_id
    AND thread.org_id = p_org_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('deleted', false, 'activeRuns', '[]'::jsonb,
      'disabledAutomations', '[]'::jsonb);
  END IF;

  -- The strong parent fence waited for uncommitted FK attachments. Lock and
  -- observe again using the next snapshot, including those committed writers.
  PERFORM run.id FROM public.agent_runs AS run
  WHERE run.chat_thread_id = owned_thread.id
  ORDER BY run.id FOR NO KEY UPDATE;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'runId', run.id, 'orgId', run.org_id
  )), '[]'::jsonb) INTO active_runs
  FROM public.agent_runs AS run
  WHERE run.chat_thread_id = owned_thread.id AND run.user_id = p_user_id
    AND run.status IN ('pending', 'running')
    AND run.trigger_source IS NOT NULL;

  WITH disabled AS (
    UPDATE public.workflow_automations AS automation
    SET enabled = false, next_run_at = NULL,
      updated_at = COALESCE(p_automation_updated_at,
        date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC'))
    WHERE automation.owner_user_id = p_user_id AND automation.enabled = true
      AND automation.workflow_id IN (
        SELECT binding.workflow_id FROM public.workflow_user_automation_threads AS binding
        WHERE binding.user_id = p_user_id AND binding.chat_thread_id = owned_thread.id
      )
    RETURNING org_id, owner_user_id, event_type, event_config, event_connector_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'orgId', disabled.org_id,
    'ownerUserId', disabled.owner_user_id,
    'eventType', disabled.event_type,
    'eventConfig', disabled.event_config,
    'eventConnectorId', disabled.event_connector_id
  )), '[]'::jsonb) INTO disabled_automations FROM disabled;

  -- Keep the original FK-free search projection and its watermark-first
  -- cleanup. An outgoing projector's race retains its existing repair anchor.
  DELETE FROM public.chat_event_search_message_watermarks
  WHERE chat_thread_id = owned_thread.id;
  DELETE FROM public.chat_event_search_messages
  WHERE chat_thread_id = owned_thread.id;

  UPDATE public.agent_runs SET chat_thread_id = NULL
  WHERE chat_thread_id = owned_thread.id;
  UPDATE public.workflow_user_automation_threads SET chat_thread_id = NULL
  WHERE chat_thread_id = owned_thread.id;

  DELETE FROM public.chat_threads WHERE id = owned_thread.id
  RETURNING id INTO deleted_id;

  IF deleted_id IS NOT NULL THEN
    -- This is a separate command, after all parent DELETE FK AFTER work.
    -- A duplicate event ID still consumes its reservation, as before.
    WITH reserved AS (
      INSERT INTO public.chat_thread_event_sequences (user_id, org_id, last_seq_id)
      VALUES (p_user_id, p_org_id, 1)
      ON CONFLICT (user_id, org_id) DO UPDATE
      SET last_seq_id = public.chat_thread_event_sequences.last_seq_id + 1
      RETURNING last_seq_id
    )
    INSERT INTO public.chat_thread_events (
      id, user_id, org_id, seq_id, chat_thread_id, kind, title, pin_order, muted, hidden, selected_model,
      model_settings, model_settings_patch, service_tier, computer_use_host_id,
      cloud_browser_enabled, created_at
    )
    SELECT COALESCE(p_event_id, gen_random_uuid()::text)::uuid,
      p_user_id, p_org_id, reserved.last_seq_id, owned_thread.id,
      'deleted'::public.chat_thread_event_kind,
      NULL, NULL, NULL, NULL, NULL,
      NULL::jsonb, NULL::jsonb, NULL, NULL::uuid,
      false, timezone('UTC', now())
    FROM reserved
    ON CONFLICT (id) DO NOTHING;
  END IF;

  RETURN jsonb_build_object('deleted', deleted_id IS NOT NULL,
    'activeRuns', active_runs, 'disabledAutomations', disabled_automations);
END;
$chat_thread_deletion$;
--> statement-breakpoint
-- okou:non-transactional
-- One finite local deletion; provider revocation remains after commit.
-- Serving/rollback APIs can omit chatAccountAccess from the existing deletion payload.
-- Retire legacy mode in #44632 after GA and old callers drain; schema cleanup follows in #44633.
CREATE OR REPLACE FUNCTION public.delete_builtin_connector_local_state(
  p_input jsonb,
  p_clock timestamp without time zone
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER PARALLEL UNSAFE
AS $connector_deletion$
DECLARE
  organization text := p_input->>'orgId';
  member text := p_input->>'userId';
  slug text := p_input->>'connectorSlug';
  chat_account_access boolean := coalesce((p_input->>'chatAccountAccess')::boolean, false);
  source_id uuid := (p_input->>'sourceId')::uuid;
  resolved_id uuid;
  was_default boolean;
  promoted uuid;
  chosen uuid;
  removed uuid;
  early_count bigint;
  late_count bigint := 0;
  at timestamp without time zone;
  automation record;
  prepared jsonb;
  projection_configs jsonb := p_input->'projections';
  existing record;
  policy jsonb;
  revoke_index integer;
  secret_rows jsonb := '[]'::jsonb;
BEGIN
  -- Preserve separate resolution and current-account reads, not a cached row.
  SELECT id INTO resolved_id FROM public.connectors
    WHERE org_id = organization AND user_id = member AND id = source_id
      AND connector_slug = slug;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('kind', 'missing');
  END IF;
  SELECT c.is_default INTO was_default FROM public.connectors AS c
    WHERE c.org_id = organization AND c.user_id = member
      AND c.connector_slug = slug AND c.id = resolved_id LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('kind', 'missing');
  END IF;
  IF was_default THEN
    SELECT id INTO promoted FROM public.connectors
      WHERE org_id = organization AND user_id = member AND connector_slug = slug
        AND id <> resolved_id AND default_enabled_for_chats
      ORDER BY created_at, id LIMIT 1;
    IF FOUND THEN
      UPDATE public.connectors SET is_default = false, updated_at = clock_timestamp()
        WHERE id = resolved_id;
      UPDATE public.connectors SET is_default = true, updated_at = clock_timestamp()
        WHERE id = promoted;
    END IF;
  END IF;

  IF chat_account_access THEN
    -- Replaced and cleared selections are disjoint; both count as resolved.
    WITH affected AS MATERIALIZED (
      SELECT selection.chat_thread_id, (
        SELECT account.id FROM public.connectors AS account
        LEFT JOIN public.chat_thread_connector_access_overrides AS access
          ON access.chat_thread_id = selection.chat_thread_id AND access.connector_id = account.id
        WHERE account.org_id = organization AND account.user_id = member
          AND account.connector_slug = slug AND account.id <> resolved_id
          AND coalesce(access.enabled, account.default_enabled_for_chats)
          AND EXISTS (
            SELECT 1 FROM public.chat_threads AS thread
            WHERE thread.id = selection.chat_thread_id AND thread.user_id = member AND thread.org_id = organization
          )
        ORDER BY account.is_default DESC, account.created_at, account.id LIMIT 1
      ) AS connector_id
      FROM public.chat_thread_connector_selections AS selection WHERE selection.connector_id = resolved_id
    ), replaced AS (
      UPDATE public.chat_thread_connector_selections AS selection SET connector_id = affected.connector_id
      FROM affected WHERE selection.chat_thread_id = affected.chat_thread_id
        AND selection.connector_id = resolved_id AND affected.connector_id IS NOT NULL
      RETURNING selection.chat_thread_id
    ), cleared AS (
      DELETE FROM public.chat_thread_connector_selections AS selection USING affected
      WHERE selection.chat_thread_id = affected.chat_thread_id
        AND selection.connector_id = resolved_id AND affected.connector_id IS NULL
      RETURNING selection.chat_thread_id
    ) SELECT (SELECT count(*) FROM replaced) + (SELECT count(*) FROM cleared) INTO early_count;
  ELSE
    DELETE FROM public.chat_thread_connector_selections WHERE connector_id = resolved_id;
    GET DIAGNOSTICS early_count = ROW_COUNT;
  END IF;
  IF slug = 'notion' THEN
    at := coalesce(p_clock, date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC'));
    UPDATE public.notion_workflow_pending_events
      SET status = 'skipped', skip_reason = 'Notion account identity changed before the event was processed',
        processed_at = at, updated_at = at
      WHERE connector_id = resolved_id AND status IN ('pending', 'running');
  END IF;

  IF slug IN ('gmail', 'google-calendar', 'google-meet', 'notion') THEN
    -- Fix the automation-row cursor once; account lookups remain fresh commands.
    FOR automation IN SELECT id, workflow_id, event_type, event_config, event_connector_id
      FROM public.workflow_automations
      WHERE org_id = organization AND owner_user_id = member AND kind = 'event'
        AND ((slug = 'gmail' AND event_type IN ('gmail-new-message', 'gmail-label-applied'))
          OR (slug = 'google-calendar' AND event_type IN ('google-calendar-event-created',
            'google-calendar-event-updated', 'google-calendar-event-cancelled'))
          OR (slug = 'google-meet' AND event_type = 'google-meet-transcript-generated')
          OR (slug = 'notion' AND event_type IN ('notion-child-page-created',
            'notion-database-item-created', 'notion-page-content-updated'))) LOOP
      IF chat_account_access THEN
        SELECT account.id INTO chosen FROM public.connectors AS account
        LEFT JOIN public.workflow_user_automation_threads AS thread
          ON thread.org_id = organization AND thread.user_id = member AND thread.workflow_id = automation.workflow_id
        LEFT JOIN public.chat_thread_connector_selections AS selection
          ON selection.chat_thread_id = thread.chat_thread_id AND selection.connector_slug = slug
        LEFT JOIN public.chat_thread_connector_access_overrides AS access
          ON access.chat_thread_id = thread.chat_thread_id AND access.connector_id = account.id
        WHERE account.org_id = organization AND account.user_id = member AND account.connector_slug = slug
          AND account.id <> resolved_id AND coalesce(access.enabled, account.default_enabled_for_chats)
        ORDER BY (account.id = selection.connector_id) DESC NULLS LAST,
          account.is_default DESC, account.created_at, account.id LIMIT 1;
      ELSE
        SELECT selection.connector_id INTO chosen
        FROM public.workflow_user_automation_threads AS thread
        JOIN public.chat_thread_connector_selections AS selection
          ON selection.chat_thread_id = thread.chat_thread_id AND selection.connector_slug = slug
        WHERE thread.org_id = organization AND thread.user_id = member
          AND thread.workflow_id = automation.workflow_id LIMIT 1;
        IF NOT FOUND THEN
          SELECT id INTO chosen FROM public.connectors
            WHERE org_id = organization AND user_id = member AND connector_slug = slug
              AND is_default LIMIT 1;
        END IF;
      END IF;

      IF slug = 'notion' THEN
        IF automation.event_connector_id IS NOT DISTINCT FROM chosen AND chosen IS NULL THEN
          CONTINUE;
        END IF;
        -- TypeScript owns the exact contract parsers, including nested URLs.
        -- Changed/new configurations reject the whole deletion, never reuse a stale template.
        prepared := projection_configs->(automation.id::text);
        IF prepared IS NULL
          OR prepared->>'eventType' IS DISTINCT FROM automation.event_type
          OR prepared->'config' IS DISTINCT FROM coalesce(automation.event_config, 'null'::jsonb) THEN
          RAISE EXCEPTION 'Connector automation configuration changed during deletion' USING ERRCODE = 'P0C01';
        END IF;
        IF automation.event_connector_id IS NOT DISTINCT FROM chosen
          AND (prepared->>'valid')::boolean
          AND automation.event_config->>'connectorId' = chosen::text THEN
          CONTINUE;
        END IF;
        IF chosen IS NOT NULL AND (prepared->>'valid')::boolean THEN
          UPDATE public.workflow_automations SET event_connector_id = chosen,
            event_config = jsonb_set(prepared->'template', '{connectorId}', to_jsonb(chosen::text))
            WHERE id = automation.id;
        ELSIF chosen IS NULL AND automation.event_config IS NOT NULL THEN
          UPDATE public.workflow_automations SET event_connector_id = chosen,
            event_config = automation.event_config WHERE id = automation.id;
        ELSE
          UPDATE public.workflow_automations SET event_connector_id = chosen WHERE id = automation.id;
        END IF;
        at := coalesce(p_clock, date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC'));
        UPDATE public.notion_workflow_pending_events
          SET status = 'skipped', skip_reason = 'Notion account selection changed before the event was processed',
            processed_at = at, updated_at = at
          WHERE automation_id = automation.id AND status IN ('pending', 'running');
      ELSE
        IF automation.event_connector_id IS NOT DISTINCT FROM chosen THEN
          CONTINUE;
        END IF;
        IF slug = 'gmail' AND automation.event_type = 'gmail-label-applied' THEN
          prepared := projection_configs->(automation.id::text);
          IF prepared IS NULL
            OR prepared->>'eventType' IS DISTINCT FROM automation.event_type
            OR prepared->'config' IS DISTINCT FROM coalesce(automation.event_config, 'null'::jsonb) THEN
            RAISE EXCEPTION 'Connector automation configuration changed during deletion' USING ERRCODE = 'P0C01';
          END IF;
          IF NOT (prepared->>'valid')::boolean THEN
            RAISE EXCEPTION 'Invalid Gmail label automation configuration';
          END IF;
          UPDATE public.workflow_automations SET event_connector_id = chosen,
            event_config = prepared->'template' WHERE id = automation.id;
        ELSIF slug = 'gmail' THEN
          UPDATE public.workflow_automations SET event_connector_id = chosen,
            event_config = automation.event_config WHERE id = automation.id;
        ELSE
          UPDATE public.workflow_automations SET event_connector_id = chosen WHERE id = automation.id;
        END IF;
      END IF;
    END LOOP;
  ELSIF slug = 'google-forms' THEN
    -- Keep Forms' target-row config expression and same-statement cursor removal.
    WITH changed AS (
      UPDATE public.workflow_automations AS target
      SET event_connector_id = desired.connector_id,
        event_config = CASE WHEN desired.connector_id IS NOT NULL
          AND target.event_config->>'connectorId' IS DISTINCT FROM desired.connector_id::text
          THEN jsonb_set(target.event_config, '{connectorId}', to_jsonb(desired.connector_id::text))
          ELSE target.event_config END
      FROM (
        SELECT a.id, CASE WHEN chat_account_access THEN (
          SELECT account.id FROM public.connectors AS account
          LEFT JOIN public.chat_thread_connector_access_overrides AS access
            ON access.chat_thread_id = t.chat_thread_id AND access.connector_id = account.id
          WHERE account.org_id = organization AND account.user_id = member AND account.connector_slug = slug
            AND account.id <> resolved_id AND coalesce(access.enabled, account.default_enabled_for_chats)
          ORDER BY (account.id = s.connector_id) DESC NULLS LAST,
            account.is_default DESC, account.created_at, account.id LIMIT 1
        ) ELSE CASE WHEN s.connector_slug IS NOT NULL THEN s.connector_id ELSE c.id END END AS connector_id
        FROM public.workflow_automations AS a
        LEFT JOIN public.workflow_user_automation_threads AS t
          ON t.org_id = a.org_id AND t.user_id = a.owner_user_id AND t.workflow_id = a.workflow_id
        LEFT JOIN public.chat_thread_connector_selections AS s
          ON s.chat_thread_id = t.chat_thread_id AND s.connector_slug = 'google-forms'
        LEFT JOIN public.connectors AS c
          ON c.org_id = organization AND c.user_id = member AND c.connector_slug = 'google-forms' AND c.is_default
        WHERE a.org_id = organization AND a.owner_user_id = member
          AND a.kind = 'event' AND a.event_type = 'google-forms-response-submitted'
      ) AS desired
      WHERE target.id = desired.id AND target.kind = 'event' AND target.event_type = 'google-forms-response-submitted'
        AND (target.event_connector_id IS DISTINCT FROM desired.connector_id
          OR (desired.connector_id IS NOT NULL
            AND target.event_config->>'connectorId' IS DISTINCT FROM desired.connector_id::text))
      RETURNING target.id
    ) DELETE FROM public.google_forms_automation_cursors WHERE automation_id IN (SELECT id FROM changed);
  END IF;

  -- Select the actual current method and opaque receipt after any parent wait.
  SELECT id, auth_method, storage_version INTO existing FROM public.connectors WHERE id = resolved_id LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Claimed connector account disappeared before deletion';
  END IF;
  SELECT value, (ordinality - 1)::integer INTO policy, revoke_index
    FROM jsonb_array_elements(p_input->'revocations') WITH ORDINALITY
    WHERE value->>'authMethod' = existing.auth_method
      AND ((value->>'anyStorageVersion')::boolean
        OR (value->>'storageVersion')::bigint = existing.storage_version)
    LIMIT 1;
  IF FOUND AND (policy->>'invalid')::boolean THEN
    RAISE EXCEPTION 'Connector secret is not declared by the selected auth method';
  END IF;
  IF FOUND AND jsonb_array_length(policy->'names') > 0 THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('name', s.name, 'encryptedValue', s.encrypted_value)), '[]'::jsonb)
      INTO secret_rows FROM public.secrets AS s
      WHERE s.org_id = organization AND s.user_id = member AND s.type = 'connector'
        AND s.connector_id = existing.id
        AND s.name IN (SELECT jsonb_array_elements_text(policy->'names'))
        AND EXISTS (SELECT 1 FROM public.connectors AS c
          WHERE c.id = existing.id AND c.org_id = organization AND c.user_id = member
            AND c.connector_slug = slug AND c.auth_method = policy->>'authMethod'
            AND c.storage_version = (policy->>'storageVersion')::bigint);
  END IF;
  DELETE FROM public.secrets WHERE connector_id = existing.id;
  DELETE FROM public.variables WHERE connector_id = existing.id;
  SET CONSTRAINTS fk_chat_thread_connector_selections_connector_slug,
    fk_chat_thread_connector_selections_custom_connector DEFERRED;
  DELETE FROM public.connectors WHERE id = existing.id RETURNING id INTO removed;
  IF FOUND THEN
    DELETE FROM public.chat_thread_connector_selections WHERE connector_id = removed;
    GET DIAGNOSTICS late_count = ROW_COUNT;
  END IF;
  SET CONSTRAINTS fk_chat_thread_connector_selections_connector_slug,
    fk_chat_thread_connector_selections_custom_connector IMMEDIATE;
  IF removed IS NOT NULL THEN
    DELETE FROM public.google_forms_automation_cursors WHERE automation_id IN (
      SELECT id FROM public.workflow_automations
      WHERE event_type = 'google-forms-response-submitted' AND event_config->>'connectorId' = removed::text
    );
  END IF;
  RETURN jsonb_build_object('kind', 'deleted', 'resolvedSelectionCount', early_count + late_count,
    'promotedDefaultConnectionId', promoted, 'revokeIndex', revoke_index, 'secretRows', secret_rows);
END;
$connector_deletion$;
