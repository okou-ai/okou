-- Each new unique index validates all existing rows. A duplicate aborts the
-- transaction with its scope and conflicting key before either column is dropped.
ALTER TABLE "org_metadata" DROP CONSTRAINT "org_metadata_default_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "workflows" DROP CONSTRAINT "workflows_agent_id_agents_id_fk";
--> statement-breakpoint
-- These rows previously derived visibility or shared execution authority from
-- their Agent. Require an explicit resolution instead of broadening access.
DO $scope$
BEGIN
  IF EXISTS (
    SELECT 1 FROM workflows w JOIN agents a ON a.id = w.agent_id
    WHERE w.org_id <> a.org_id OR (w.visibility = 'public' AND a.visibility = 'private' AND w.owner_user_id <> a.owner)
  ) THEN
    RAISE EXCEPTION 'Workflow has a foreign workspace or two distinct legacy private readers'
      USING HINT = 'Review scripts/audit-workspace-workflow-identity.sql before retrying.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM org_metadata m
    LEFT JOIN agents a ON a.org_id = m.org_id AND a.name = 'default-agent' AND a.visibility = 'public'
    WHERE m.default_agent_id IS DISTINCT FROM a.id
  ) THEN
    RAISE EXCEPTION 'Workspace default executor differs from the shared bootstrap profile'
      USING HINT = 'Review scripts/audit-workspace-workflow-identity.sql before retrying.';
  END IF;
END;
$scope$;
--> statement-breakpoint
DROP INDEX "idx_workflows_agent";--> statement-breakpoint
DROP INDEX "idx_workflows_public_agent_name_unique";--> statement-breakpoint
DROP INDEX "idx_workflows_ordinary_private_owner_agent_name_unique";--> statement-breakpoint
DROP INDEX "idx_workflows_official_owner_agent_definition_unique";--> statement-breakpoint
DROP INDEX "idx_workflows_morning_brief_owner_agent_unique";--> statement-breakpoint
-- A public Workflow on its owner's private Agent was already visible only to
-- that owner. Preserve its ID, references, content and effective audience.
UPDATE workflows w SET visibility = 'private'
FROM agents a WHERE w.agent_id = a.id AND w.org_id = a.org_id
  AND w.visibility = 'public' AND a.visibility = 'private' AND w.owner_user_id = a.owner;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workflows_public_org_name_unique" ON "workflows" USING btree ("org_id","name") WHERE visibility = 'public';--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workflows_ordinary_private_owner_name_unique" ON "workflows" USING btree ("org_id","owner_user_id","name") WHERE visibility = 'private' AND official_definition_name IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workflows_official_owner_definition_unique" ON "workflows" USING btree ("org_id","owner_user_id","official_definition_name") WHERE official_definition_name IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workflows_morning_brief_owner_unique" ON "workflows" USING btree ("org_id","owner_user_id") WHERE official_definition_name IN ('morning-brief', 'internal-test-morning-brief');--> statement-breakpoint
ALTER TABLE "org_metadata" DROP COLUMN "default_agent_id";--> statement-breakpoint
ALTER TABLE "workflows" DROP COLUMN "agent_id";
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
--> statement-breakpoint
-- One caller-owned statement; no explicit transaction, trigger or new lock.
-- VOLATILE is required: internal statements take fresh READ COMMITTED snapshots.
CREATE OR REPLACE FUNCTION public.update_agent_metadata(
  p_org_id text, p_agent_id uuid, p_member_id text, p_is_admin boolean,
  p_identity_changes boolean, p_visibility text, p_public_limit integer,
  p_body bytea, p_now timestamp without time zone
) RETURNS TABLE (existing jsonb, agent jsonb)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER PARALLEL UNSAFE
AS $agent_metadata$
DECLARE
  current_agent record;
  public_count bigint := 0;
  patch jsonb;
BEGIN
  PERFORM a.id FROM public.agents AS a
    WHERE a.org_id = p_org_id AND a.id = p_agent_id FOR UPDATE;

  SELECT a.id, a.owner, a.visibility, CASE WHEN a.name = 'default-agent' AND a.visibility = 'public' THEN a.id END AS default_executor_id
    INTO current_agent
    FROM public.agents AS a
    WHERE a.org_id = p_org_id AND a.id = p_agent_id LIMIT 1;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  existing := pg_catalog.jsonb_build_object(
    'id', current_agent.id, 'owner', current_agent.owner,
    'visibility', current_agent.visibility,
    'defaultAgentId', current_agent.default_executor_id, 'publicAgentCount', 0);
  agent := NULL;

  -- Return locked facts for the existing HTTP error classifiers. No body text
  -- is admitted and no Agent write occurs for any rejected operation.
  IF NOT (current_agent.owner = p_member_id OR
      (p_is_admin AND current_agent.visibility = 'public')) OR
    (p_identity_changes AND current_agent.id = current_agent.default_executor_id) OR
    (p_visibility IS NOT NULL AND current_agent.owner <> p_member_id) THEN
    RETURN NEXT;
    RETURN;
  END IF;

  IF p_visibility = 'public' AND current_agent.visibility <> 'public' THEN
    SELECT pg_catalog.count(*) INTO public_count FROM public.agents AS a
      WHERE a.org_id = p_org_id AND a.visibility = 'public';
    existing := existing || pg_catalog.jsonb_build_object('publicAgentCount', public_count);
    IF public_count >= p_public_limit THEN
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  -- The bound JSON carries base64-encoded UTF8 fields. Decode text only after
  -- every rejection gate, preserving driver UTF8 conversion and NUL errors.
  patch := pg_catalog.convert_from(p_body, 'UTF8')::jsonb;
  UPDATE public.agents AS a SET
    display_name = CASE WHEN patch ? 'displayName' THEN pg_catalog.convert_from(pg_catalog.decode(patch ->> 'displayName', 'base64'), 'UTF8') ELSE a.display_name END,
    description = CASE WHEN patch ? 'description' THEN pg_catalog.convert_from(pg_catalog.decode(patch ->> 'description', 'base64'), 'UTF8') ELSE a.description END,
    sound = CASE WHEN patch ? 'sound' THEN pg_catalog.convert_from(pg_catalog.decode(patch ->> 'sound', 'base64'), 'UTF8') ELSE a.sound END,
    avatar_url = CASE WHEN patch ? 'avatarUrl' THEN pg_catalog.convert_from(pg_catalog.decode(patch ->> 'avatarUrl', 'base64'), 'UTF8') ELSE a.avatar_url END,
    visibility = CASE WHEN p_visibility IS NOT NULL THEN p_visibility ELSE a.visibility END,
    updated_at = COALESCE(p_now, pg_catalog.date_trunc('milliseconds',
      pg_catalog.timezone('UTC', pg_catalog.clock_timestamp())))
    WHERE a.org_id = p_org_id AND a.id = p_agent_id;

  SELECT pg_catalog.jsonb_build_object(
    'agentId', a.id, 'defaultAgentId', CASE WHEN a.name = 'default-agent' AND a.visibility = 'public' THEN a.id END, 'owner', a.owner,
    'displayName', a.display_name, 'description', a.description,
    'sound', a.sound, 'avatarUrl', a.avatar_url, 'visibility', a.visibility)
    INTO agent FROM public.agents AS a
    WHERE a.org_id = p_org_id AND a.id = p_agent_id LIMIT 1;
  IF agent IS NULL THEN
    RAISE EXCEPTION 'Canonical Agent missing after update: %', p_agent_id;
  END IF;
  RETURN NEXT;
END;
$agent_metadata$;
