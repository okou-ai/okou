-- okou:non-transactional
-- Keep each post-lock operation as a separate VOLATILE function command: a
-- waiting statement snapshot must not lose an Automation's watch identity or
-- an outgoing Stage 1 publication token committed by the preceding lock owner.
CREATE OR REPLACE FUNCTION public.delete_workflow_rows(
  p_org_id text,
  p_workflow_id uuid,
  p_allow_official_installation_deletion boolean,
  p_required_official_installation_state text
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
PARALLEL UNSAFE
AS $workflow_deletion$
DECLARE
  observed_agent_id uuid;
  locked_agent_id uuid;
  locked_workflow record;
  observed_automations jsonb;
  removed_automations jsonb;
  attachment_key text;
  attachment_prefix text;
BEGIN
  SELECT workflow.agent_id INTO observed_agent_id
  FROM public.workflows AS workflow
  WHERE workflow.org_id = p_org_id AND workflow.id = p_workflow_id
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('deleted', false);
  END IF;

  SELECT agent.id INTO locked_agent_id
  FROM public.agents AS agent
  WHERE agent.id = observed_agent_id AND agent.org_id = p_org_id
  LIMIT 1 FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('deleted', false);
  END IF;

  SELECT workflow.id, workflow.org_id, workflow.attachments,
    workflow.agent_id, workflow.name, workflow.owner_user_id,
    workflow.official_definition_name, workflow.official_installation_state
  INTO locked_workflow
  FROM public.workflows AS workflow
  WHERE workflow.org_id = p_org_id AND workflow.id = p_workflow_id
  LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('deleted', false);
  END IF;
  IF p_required_official_installation_state IS NOT NULL
    AND locked_workflow.official_installation_state IS DISTINCT FROM
      p_required_official_installation_state THEN
    RETURN jsonb_build_object('deleted', false);
  END IF;
  IF locked_workflow.official_definition_name IS NOT NULL
    AND p_allow_official_installation_deletion IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      CONSTRAINT = 'workflow_deletion_official_protected',
      MESSAGE = 'Uninstall Official Workflows through the Official installation endpoint';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'orgId', automation.org_id,
    'ownerUserId', automation.owner_user_id,
    'eventType', automation.event_type,
    'eventConfig', automation.event_config,
    'eventConnectorId', automation.event_connector_id
  )), '[]'::jsonb)
  INTO observed_automations
  FROM public.workflow_automations AS automation
  WHERE automation.workflow_id = locked_workflow.id;

  -- Active identities must be removed before their Automation's SET NULL.
  DELETE FROM public.official_workflow_automation_identities
  WHERE workflow_id = locked_workflow.id;

  WITH removed AS (
    DELETE FROM public.workflow_automations
    WHERE workflow_id = locked_workflow.id
    RETURNING org_id, owner_user_id, event_type, event_config, event_connector_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'orgId', removed.org_id,
    'ownerUserId', removed.owner_user_id,
    'eventType', removed.event_type,
    'eventConfig', removed.event_config,
    'eventConnectorId', removed.event_connector_id
  )), '[]'::jsonb)
  INTO removed_automations FROM removed;

  DELETE FROM public.workflows WHERE id = locked_workflow.id;

  IF locked_workflow.attachments->>'kind' = 'bundle' THEN
    attachment_key := locked_workflow.attachments->>'objectKey';
    attachment_prefix := 'workflow-attachments/' || locked_workflow.org_id
      || '/' || locked_workflow.id::text || '/';
    IF attachment_key IS NULL
      OR left(attachment_key, length(attachment_prefix)) COLLATE "C"
        <> attachment_prefix COLLATE "C"
      OR NOT (attachment_key COLLATE "C"
        ~ '^workflow-attachments/[^/]+/[a-f0-9-]{36}/[a-f0-9-]{36}/archive[.]tar[.]gz$') THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        CONSTRAINT = 'workflow_deletion_attachment_owner',
        MESSAGE = 'Workflow attachment package has a foreign owner';
    END IF;
    INSERT INTO public.background_jobs
      (id, kind, handler_version, org_id, user_id, input)
    VALUES (
      gen_random_uuid(), 'workflow-attachment-cleanup', 1,
      locked_workflow.org_id, locked_workflow.owner_user_id,
      jsonb_build_object('workflowId', locked_workflow.id,
        'objectKey', attachment_key)
    );
  END IF;

  -- Retain the outgoing writer's Workflow-row-before-token lock order and
  -- every subject at this exact org/Agent/Workflow publication key.
  DELETE FROM public.storage_publication_tokens
  WHERE org_id = p_org_id AND agent_id = locked_workflow.agent_id
    AND publication_key = 'workflow:' || locked_workflow.id::text;

  RETURN jsonb_build_object('deleted', true,
    'automations', observed_automations || removed_automations);
END;
$workflow_deletion$;
