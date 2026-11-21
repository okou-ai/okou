ALTER TABLE "workflows" DROP CONSTRAINT "workflows_agent_id_agents_id_fk";
--> statement-breakpoint
DROP INDEX "idx_workflows_agent";--> statement-breakpoint
DROP INDEX "idx_workflows_public_agent_name_unique";--> statement-breakpoint
DROP INDEX "idx_workflows_ordinary_private_owner_agent_name_unique";--> statement-breakpoint
DROP INDEX "idx_workflows_official_owner_agent_definition_unique";--> statement-breakpoint
DROP INDEX "idx_workflows_morning_brief_owner_agent_unique";--> statement-breakpoint
-- Keep workflows that were hidden by private hosts private at cutover.
UPDATE workflows AS w SET visibility = 'private'
WHERE w.visibility = 'public' AND NOT EXISTS (
  SELECT 1 FROM agents AS a
  WHERE a.id = w.agent_id AND a.org_id = w.org_id AND a.visibility = 'public'
);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workflows_public_name_unique" ON "workflows" USING btree ("org_id","name") WHERE visibility = 'public';--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workflows_private_owner_name_unique" ON "workflows" USING btree ("org_id","owner_user_id","name") WHERE visibility = 'private' AND official_definition_name IS NULL;--> statement-breakpoint
ALTER TABLE "workflows" DROP COLUMN "agent_id";
--> statement-breakpoint
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
  locked_workflow record;
  observed_automations jsonb;
  removed_automations jsonb;
  attachment_key text;
  attachment_prefix text;
  inherited_attachment boolean;
BEGIN
  SELECT workflow.id, workflow.org_id, workflow.attachments,
    workflow.name, workflow.owner_user_id,
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
    -- Only the deterministic same-workspace copy shares immutable content.
    -- The source upload remains independently owned. Match the API reader in
    -- core/src/single-agent-migration.ts and retire after convergence (#46783).
    inherited_attachment := (
      split_part(attachment_key, '/', 2) COLLATE "C" = locked_workflow.org_id COLLATE "C"
      AND attachment_key COLLATE "C" ~ '^workflow-attachments/[^/]+/[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}/[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}/archive[.]tar[.]gz$'
      AND overlay(overlay(md5(
        CASE WHEN locked_workflow.org_id COLLATE "C" = 'org_3ANttyrbWYJk6JKRSTRLEsbsDLe'
          THEN 'staff-single-agent-workflow-v1:'
          ELSE 'inactive-batch-workflow-v1:'
        END || split_part(attachment_key, '/', 3)
      ) placing '5' from 13 for 1) placing '8' from 17 for 1)::uuid = locked_workflow.id
    ) IS TRUE;
    IF NOT inherited_attachment THEN
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
  END IF;

  RETURN jsonb_build_object('deleted', true,
    'automations', observed_automations || removed_automations);
END;
$workflow_deletion$;
