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
    AND EXISTS (
      SELECT agent.id FROM public.agents AS agent
      WHERE agent.id = thread.agent_id AND agent.org_id = p_org_id
    );
  IF NOT FOUND THEN
    RETURN jsonb_build_object('deleted', false, 'activeRuns', '[]'::jsonb,
      'disabledAutomations', '[]'::jsonb);
  END IF;

  PERFORM run.id FROM public.agent_runs AS run
  WHERE run.chat_thread_id = p_thread_id
  ORDER BY run.id FOR NO KEY UPDATE;
  PERFORM sequence.chat_thread_id FROM public.chat_event_sequences AS sequence
  WHERE sequence.chat_thread_id = p_thread_id FOR UPDATE;

  SELECT thread.id, thread.agent_id INTO owned_thread
  FROM public.chat_threads AS thread
  WHERE thread.id = p_thread_id AND thread.user_id = p_user_id
    AND EXISTS (
      SELECT agent.id FROM public.agents AS agent
      WHERE agent.id = thread.agent_id AND agent.org_id = p_org_id
    )
  FOR UPDATE;
  IF NOT FOUND OR owned_thread.agent_id IS NULL THEN
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
      id, user_id, org_id, seq_id, chat_thread_id, kind, agent_id,
      reassigned_agent_id, title, pin_order, muted, hidden, selected_model,
      model_settings, model_settings_patch, service_tier, computer_use_host_id,
      cloud_browser_enabled, created_at
    )
    SELECT COALESCE(p_event_id, gen_random_uuid()::text)::uuid,
      p_user_id, p_org_id, reserved.last_seq_id, owned_thread.id,
      'deleted'::public.chat_thread_event_kind, owned_thread.agent_id,
      NULL::uuid, NULL, NULL, NULL, NULL, NULL,
      NULL::jsonb, NULL::jsonb, NULL, NULL::uuid,
      false, timezone('UTC', now())
    FROM reserved
    ON CONFLICT (id) DO NOTHING;
  END IF;

  RETURN jsonb_build_object('deleted', deleted_id IS NOT NULL,
    'activeRuns', active_runs, 'disabledAutomations', disabled_automations);
END;
$chat_thread_deletion$;
