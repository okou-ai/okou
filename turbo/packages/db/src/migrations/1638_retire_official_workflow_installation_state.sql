-- okou:after-api-promotion
LOCK TABLE public.workflows, public.workflow_automations IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.workflows
    WHERE official_definition_name IS NOT NULL
      AND official_installation_state IS DISTINCT FROM 'installed'
  ) THEN
    RAISE EXCEPTION 'Cannot retire installation state while an Official Workflow is incomplete';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.workflow_automations
    WHERE official_blueprint_key IS NOT NULL AND (kind <> 'schedule' OR official_reconciliation_status = 'reconciling')
  ) THEN
    RAISE EXCEPTION 'Cannot retire Official event activation while a staged automation exists';
  END IF;
END
$verify$;
--> statement-breakpoint
-- Preserve separate post-lock commands so an Automation's watch identity uses
-- the fresh snapshot after a preceding lock owner commits.
CREATE OR REPLACE FUNCTION public.delete_workflow_rows(
  p_org_id text,
  p_workflow_id uuid
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
    workflow.official_definition_name
  INTO locked_workflow
  FROM public.workflows AS workflow
  WHERE workflow.org_id = p_org_id AND workflow.id = p_workflow_id
  LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('deleted', false);
  END IF;
  IF locked_workflow.official_definition_name IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      CONSTRAINT = 'workflow_deletion_official_protected',
      MESSAGE = 'Official Workflow installations are read-only';
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
-- Outgoing readers still expect the physical installation state and cron binding.
-- These triggers cover only the handoff to the atomic installers.
CREATE OR REPLACE FUNCTION public.project_outgoing_official_installation() RETURNS trigger
LANGUAGE plpgsql AS $project$
BEGIN
  NEW.official_installation_state := 'installed';
  RETURN NEW;
END
$project$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER project_outgoing_official_installation
BEFORE INSERT ON public.workflows FOR EACH ROW
WHEN (NEW.official_definition_name IS NOT NULL AND NEW.official_installation_state IS NULL)
EXECUTE FUNCTION public.project_outgoing_official_installation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.project_outgoing_builtin_cron() RETURNS trigger
LANGUAGE plpgsql AS $project$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.cron_expression IS NOT DISTINCT FROM OLD.cron_expression
       OR NEW.official_parameter_bindings IS DISTINCT FROM OLD.official_parameter_bindings
       OR OLD.official_parameter_bindings IS DISTINCT FROM jsonb_build_array(jsonb_build_object('key', 'cron', 'value', OLD.cron_expression)) THEN
      RETURN NEW;
    END IF;
  ELSIF NEW.official_parameter_bindings IS DISTINCT FROM '[]'::jsonb THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.workflows w WHERE w.id = NEW.workflow_id
    AND (w.official_definition_name, NEW.official_blueprint_key) IN (
      ('morning-brief', 'daily-delivery'), ('internal-test-morning-brief', 'daily-delivery'),
      ('agent-suggestions', 'hourly-check'), ('proactive-learning', 'nightly-learning')
    )) THEN
    NEW.official_parameter_bindings := jsonb_build_array(jsonb_build_object('key', 'cron', 'value', NEW.cron_expression));
  END IF;
  RETURN NEW;
END
$project$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER project_outgoing_builtin_cron
BEFORE INSERT OR UPDATE OF cron_expression ON public.workflow_automations FOR EACH ROW
WHEN (NEW.kind = 'schedule' AND NEW.schedule_type = 'cron' AND NEW.official_blueprint_key IS NOT NULL)
EXECUTE FUNCTION public.project_outgoing_builtin_cron();
--> statement-breakpoint
-- okou:after-api-promotion
DROP TRIGGER project_outgoing_builtin_cron ON public.workflow_automations;
--> statement-breakpoint
-- okou:after-api-promotion
DROP FUNCTION public.project_outgoing_builtin_cron();
--> statement-breakpoint
-- okou:after-api-promotion
DROP TRIGGER project_outgoing_official_installation ON public.workflows;
--> statement-breakpoint
-- okou:after-api-promotion
DROP FUNCTION public.project_outgoing_official_installation();
--> statement-breakpoint
-- okou:after-api-promotion
DROP FUNCTION public.delete_workflow_rows(text, uuid, boolean, text);
--> statement-breakpoint
-- okou:after-api-promotion
ALTER TABLE "workflow_automations" DROP CONSTRAINT "workflow_automations_official_binding_check";
--> statement-breakpoint
-- okou:after-api-promotion
ALTER TABLE "workflows" DROP CONSTRAINT "workflows_official_installation_check";
--> statement-breakpoint
-- okou:after-api-promotion
ALTER TABLE "workflows" DROP COLUMN "official_installation_state";
--> statement-breakpoint
-- okou:after-api-promotion
ALTER TABLE "workflow_automations" ADD CONSTRAINT "workflow_automations_official_binding_check" CHECK ((
          "workflow_automations"."official_blueprint_key" IS NULL
          AND "workflow_automations"."official_applied_fingerprint" IS NULL
          AND "workflow_automations"."official_reconciliation_status" IS NULL
          AND "workflow_automations"."official_parameter_bindings" IS NULL
          AND "workflow_automations"."official_intended_enabled" IS NULL
        ) OR (
          "workflow_automations"."official_blueprint_key" IS NOT NULL
          AND "workflow_automations"."official_applied_fingerprint" ~ '^[0-9a-f]{64}$'
          AND "workflow_automations"."kind" = 'schedule'
          AND "workflow_automations"."official_reconciliation_status" IN ('current', 'needs_reconfiguration', 'failed')
          AND jsonb_typeof("workflow_automations"."official_parameter_bindings") = 'array'
          AND "workflow_automations"."official_intended_enabled" IS NOT NULL
        ));
--> statement-breakpoint
-- okou:after-api-promotion
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_official_installation_check" CHECK ("workflows"."official_definition_name" IS NULL OR (
          "workflows"."official_definition_name" = "workflows"."name"
          AND "workflows"."visibility" = 'private'
          AND "workflows"."instruction" IS NULL
          AND "workflows"."display_name" IS NULL
          AND "workflows"."description" IS NULL
        ));
