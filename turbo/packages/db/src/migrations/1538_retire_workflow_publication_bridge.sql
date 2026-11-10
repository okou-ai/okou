-- Retire only the drained Stage 1 reservation cleanup. Legacy tables and data
-- remain available to the preceding API until a later physical contraction.
DO $c11$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc
      WHERE oid = 'public.delete_agent_rows(uuid,text,text,boolean)'::regprocedure)
    IS DISTINCT FROM '92643bf0c1e256d924d2cf022c7c3657' THEN
    RAISE EXCEPTION 'C11: unexpected Agent deletion function; preserve its current contract';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc
      WHERE oid = 'public.delete_workflow_rows(text,uuid,boolean,text)'::regprocedure)
    IS DISTINCT FROM '10474201f5b27fc7f34631dcc0a84e10' THEN
    RAISE EXCEPTION 'C11: unexpected Workflow deletion function; preserve its current contract';
  END IF;
END;
$c11$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.delete_agent_rows(
  p_agent_id uuid,
  p_org_id text,
  p_member_user_id text,
  p_is_org_admin boolean
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
PARALLEL UNSAFE
AS $function$
DECLARE
  target record;
  default_agent_id uuid;
  pass integer;
  run_ids uuid[];
  foreign_run boolean;
  active_run boolean;
  deleted_runs jsonb;
  automations jsonb;
  removed_automations jsonb;
  removed_workflows jsonb;
  retired jsonb;
  object_key text;
  references_to_release jsonb;
  batch jsonb;
  locked_hashes text[];
  batch_offset integer := 0;
  changed integer;
  deleted_run_count integer;
  released_reference_count integer;
BEGIN
  -- Keep the original local timeout and unlocked preflight, then revalidate
  -- permission/default identity under the existing Agent NOWAIT lock.
  PERFORM set_config('lock_timeout', '100ms', true);
  FOR pass IN 1..2 LOOP
    IF pass = 1 THEN
      SELECT a.id, a.owner, a.visibility INTO target FROM public.agents a
      WHERE a.id = p_agent_id AND a.org_id = p_org_id LIMIT 1;
    ELSE
      SELECT a.id, a.owner, a.visibility INTO target FROM public.agents a
      WHERE a.id = p_agent_id AND a.org_id = p_org_id LIMIT 1
      FOR UPDATE NOWAIT;
    END IF;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('kind', 'missing');
    END IF;
    IF target.visibility NOT IN ('public', 'private') THEN
      RAISE EXCEPTION 'Invalid Agent visibility during deletion'
        USING CONSTRAINT = 'agent_deletion_invalid_visibility';
    END IF;
    IF NOT (
      COALESCE(target.owner COLLATE "C" = p_member_user_id COLLATE "C", false)
      OR (target.visibility <> 'private' AND p_is_org_admin IS TRUE)
    ) THEN
      RETURN jsonb_build_object('kind', 'permission-denied',
        'owner', target.owner, 'visibility', target.visibility);
    END IF;
    SELECT o.default_agent_id INTO default_agent_id FROM public.org_metadata o
    WHERE o.org_id = p_org_id;
    IF target.id = default_agent_id THEN
      RETURN jsonb_build_object('kind', 'default-agent');
    END IF;
  END LOOP;

  -- Consume and lock the complete ordered Run set before either rejection.
  SELECT COALESCE(array_agg(r.id ORDER BY r.id), ARRAY[]::uuid[]),
    COALESCE(bool_or(r.org_id <> p_org_id OR
      (r.agent_id IS NOT NULL AND r.agent_id <> p_agent_id)), false),
    COALESCE(bool_or(r.status IN ('pending', 'running') OR
      r.attachments_retained), false)
  INTO run_ids, foreign_run, active_run
  FROM (
    SELECT r.id, r.org_id, r.agent_id, r.status, EXISTS (
      SELECT 1 FROM public.claimed_workflow_attachments c WHERE c.run_id = r.id
    ) AS attachments_retained
    FROM public.agent_runs r WHERE r.agent_id = ANY(ARRAY[p_agent_id])
    ORDER BY r.id FOR UPDATE OF r NOWAIT
  ) r;
  IF foreign_run THEN
    RETURN jsonb_build_object('kind', 'ownership-conflict');
  END IF;
  IF active_run THEN
    RETURN jsonb_build_object('kind', 'active-run');
  END IF;

  -- Sequence ownership precedes the Agent cascade, as in direct append.
  PERFORM s.chat_thread_id FROM public.chat_event_sequences s
  INNER JOIN public.chat_threads t ON t.id = s.chat_thread_id
  WHERE t.agent_id = p_agent_id ORDER BY s.chat_thread_id FOR UPDATE OF s;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'orgId', a.org_id, 'ownerUserId', a.owner_user_id,
    'eventType', a.event_type, 'eventConfig', a.event_config,
    'eventConnectorId', a.event_connector_id
  )), '[]'::jsonb) INTO automations
  FROM public.workflow_automations a WHERE EXISTS (
    SELECT 1 FROM public.workflows w WHERE w.id = a.workflow_id
      AND w.agent_id = p_agent_id AND w.org_id = p_org_id
  );

  -- The actual winning DELETE rows own their historical blob references.
  WITH deleted_callbacks AS (
    DELETE FROM public.agent_run_callbacks WHERE run_id = ANY(run_ids) RETURNING id
  ), deleted_jobs AS (
    DELETE FROM public.runner_job_queue WHERE run_id = ANY(run_ids) RETURNING run_id
  ), detached_usage AS (
    UPDATE public.usage_event SET run_id = NULL WHERE run_id = ANY(run_ids) RETURNING id
  ), deleted AS (
    DELETE FROM public.agent_runs WHERE id = ANY(run_ids)
      AND ((SELECT count(*) FROM deleted_callbacks) +
        (SELECT count(*) FROM deleted_jobs) +
        (SELECT count(*) FROM detached_usage)) >= 0
    RETURNING id, legacy_conversation_history_hash AS hash
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'hash', hash)), '[]'::jsonb)
  INTO deleted_runs FROM deleted;
  deleted_run_count := jsonb_array_length(deleted_runs);
  IF deleted_run_count <> cardinality(run_ids) THEN
    RAISE EXCEPTION 'Conversation deletion lost a locked run'
      USING CONSTRAINT = 'agent_deletion_lost_run';
  END IF;

  -- Retire Official identities before Automation deletion can SET NULL its FK.
  DELETE FROM public.official_workflow_automation_identities i WHERE EXISTS (
    SELECT 1 FROM public.workflows w WHERE w.id = i.workflow_id
      AND w.agent_id = p_agent_id AND w.org_id = p_org_id
  );
  WITH removed AS (
    DELETE FROM public.workflow_automations a WHERE EXISTS (
      SELECT 1 FROM public.workflows w WHERE w.id = a.workflow_id
        AND w.agent_id = p_agent_id AND w.org_id = p_org_id
    ) RETURNING a.org_id, a.owner_user_id, a.event_type, a.event_config, a.event_connector_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'orgId', org_id, 'ownerUserId', owner_user_id,
    'eventType', event_type, 'eventConfig', event_config,
    'eventConnectorId', event_connector_id
  )), '[]'::jsonb) INTO removed_automations FROM removed;

  -- Consume every DELETE RETURNING row before inserting cleanup work. This
  -- descriptor includes a concurrent edit that won before the parent DELETE.
  WITH removed AS (
    DELETE FROM public.workflows WHERE agent_id = p_agent_id AND org_id = p_org_id
    RETURNING id, owner_user_id, attachments
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', id, 'ownerUserId', owner_user_id, 'attachments', attachments
  )), '[]'::jsonb) INTO removed_workflows FROM removed;
  FOR retired IN SELECT value FROM jsonb_array_elements(removed_workflows) LOOP
    IF retired->'attachments'->>'kind' = 'bundle' THEN
      object_key := retired->'attachments'->>'objectKey';
      IF (jsonb_typeof(retired->'attachments'->'objectKey') = 'string'
        AND starts_with(object_key, 'workflow-attachments/' || p_org_id || '/' ||
          (retired->>'id') || '/')
        AND object_key ~ '^workflow-attachments/[^/]+/[a-f0-9-]{36}/[a-f0-9-]{36}/archive\.tar\.gz$'
      ) IS NOT TRUE THEN
        RAISE EXCEPTION 'Workflow attachment package has a foreign owner'
          USING CONSTRAINT = 'agent_deletion_attachment_owner';
      END IF;
      INSERT INTO public.background_jobs
        (id, kind, handler_version, org_id, user_id, input)
      VALUES (gen_random_uuid(), 'workflow-attachment-cleanup', 1, p_org_id,
        retired->>'ownerUserId', jsonb_build_object(
          'workflowId', retired->>'id', 'objectKey', object_key));
    END IF;
  END LOOP;

  WITH detached_runs AS (
    UPDATE public.agent_runs SET chat_thread_id = NULL WHERE chat_thread_id IN (
      SELECT t.id FROM public.chat_threads t INNER JOIN public.agents a ON t.agent_id = a.id
      WHERE a.id = p_agent_id AND a.org_id = p_org_id
    ) RETURNING id
  ), detached_bindings AS (
    UPDATE public.workflow_user_automation_threads SET chat_thread_id = NULL
    WHERE chat_thread_id IN (
      SELECT t.id FROM public.chat_threads t INNER JOIN public.agents a ON t.agent_id = a.id
      WHERE a.id = p_agent_id AND a.org_id = p_org_id
    ) RETURNING id
  )
  DELETE FROM public.agents WHERE id = p_agent_id AND org_id = p_org_id
    AND ((SELECT count(*) FROM detached_runs) +
      (SELECT count(*) FROM detached_bindings)) >= 0;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('hash', r.hash,
    'release_count', r.release_count) ORDER BY r.hash COLLATE "C"), '[]'::jsonb),
    COALESCE(sum(r.release_count), 0)::integer
  INTO references_to_release, released_reference_count
  FROM (
    SELECT x.hash, count(*)::integer AS release_count
    FROM jsonb_to_recordset(deleted_runs) AS x(id uuid, hash text)
    WHERE x.hash IS NOT NULL GROUP BY x.hash
  ) r;
  -- Blob ownership/release stays LAST, in the existing 500-hash batches.
  -- Content-addressed hashes are lowercase SHA-256; C and JS locale order agree.
  WHILE batch_offset < jsonb_array_length(references_to_release) LOOP
    SELECT jsonb_agg(x.value ORDER BY x.ordinality) INTO batch
    FROM jsonb_array_elements(references_to_release) WITH ORDINALITY x(value, ordinality)
    WHERE x.ordinality > batch_offset AND x.ordinality <= batch_offset + 500;
    SELECT COALESCE(array_agg(b.hash), ARRAY[]::text[]) INTO locked_hashes FROM (
      SELECT b.hash FROM public.blobs b WHERE b.hash IN (
        SELECT x.hash FROM jsonb_to_recordset(batch) AS x(hash text, release_count integer)
      ) ORDER BY b.hash FOR UPDATE OF b NOWAIT
    ) b;
    IF cardinality(locked_hashes) <> jsonb_array_length(batch) THEN
      RAISE EXCEPTION 'Conversation history reference accounting failed: missing blob references'
        USING CONSTRAINT = 'agent_deletion_missing_blob';
    END IF;
    UPDATE public.blobs b SET ref_count = b.ref_count - x.release_count
    FROM jsonb_to_recordset(batch) AS x(hash text, release_count integer)
    WHERE b.hash = x.hash AND b.ref_count >= x.release_count;
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed <> jsonb_array_length(batch) THEN
      RAISE EXCEPTION 'Conversation history reference accounting failed: missing or insufficient blob references'
        USING CONSTRAINT = 'agent_deletion_insufficient_blob';
    END IF;
    batch_offset := batch_offset + 500;
  END LOOP;
  RETURN jsonb_build_object('kind', 'deleted',
    'automations', automations || removed_automations,
    'conversationDeletion', jsonb_build_object('deletedRuns', deleted_run_count,
      'releasedReferences', released_reference_count,
      'releasedHashes', jsonb_array_length(references_to_release)));
END;
$function$;
--> statement-breakpoint
-- Preserve separate post-lock commands so an Automation's watch identity uses
-- the fresh snapshot after a preceding lock owner commits.
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

  RETURN jsonb_build_object('deleted', true,
    'automations', observed_automations || removed_automations);
END;
$workflow_deletion$;
