-- okou:non-transactional
-- One finite local deletion; provider revocation remains after commit.
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
        AND id <> resolved_id ORDER BY created_at, id LIMIT 1;
    IF FOUND THEN
      UPDATE public.connectors SET is_default = false, updated_at = clock_timestamp()
        WHERE id = resolved_id;
      UPDATE public.connectors SET is_default = true, updated_at = clock_timestamp()
        WHERE id = promoted;
    END IF;
  END IF;

  DELETE FROM public.chat_thread_connector_selections WHERE connector_id = resolved_id;
  GET DIAGNOSTICS early_count = ROW_COUNT;
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
        SELECT a.id, CASE WHEN s.connector_slug IS NOT NULL THEN s.connector_id ELSE c.id END AS connector_id
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
