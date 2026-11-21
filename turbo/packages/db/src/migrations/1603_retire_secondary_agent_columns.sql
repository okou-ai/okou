ALTER TABLE "agent_drafts" DROP CONSTRAINT "agent_drafts_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "banking_agent_enablements" DROP CONSTRAINT "banking_agent_enablements_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "link_wallet_connections" DROP CONSTRAINT "link_wallet_connections_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "link_wallet_spends" DROP CONSTRAINT "link_wallet_spends_agent_id_agents_id_fk";
--> statement-breakpoint
DROP INDEX "idx_agent_drafts_user_org_agent";--> statement-breakpoint
DROP INDEX "idx_banking_agent_enablements_agent_user";--> statement-breakpoint
DROP INDEX "idx_link_wallet_connections_owner_agent";--> statement-breakpoint
DROP INDEX "idx_banking_agent_enablements_unique";--> statement-breakpoint
DROP INDEX "idx_link_wallet_connections_owner";--> statement-breakpoint
DROP INDEX "idx_link_wallet_spends_intent";--> statement-breakpoint
ALTER TABLE "link_wallet_connections" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
-- Replace old composer drafts with one new draft per workspace member.
DELETE FROM public.agent_drafts;
--> statement-breakpoint
-- Retain old wallet connections for reconciliation and provider revocation.
-- Never promote an Agent grant to a workspace-wide wallet authorization.
UPDATE public.link_wallet_connections
SET retired_at = CURRENT_TIMESTAMP, revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
WHERE agent_id IS NOT NULL;
--> statement-breakpoint
-- Pick one record per member and connection. Conflicting live policy requires
-- fresh consent. Compare policy as a whole rather than unioning its grants.
CREATE TEMP TABLE banking_workspace_grant_plan ON COMMIT DROP AS
WITH grants AS (
  SELECT *, revoked_at IS NULL AND expires_at > timezone('UTC', statement_timestamp()) AS live
  FROM public.banking_agent_enablements
), conflicts AS (
  SELECT org_id, user_id, connection_id
  FROM grants
  WHERE live
  GROUP BY org_id, user_id, connection_id
  HAVING count(DISTINCT jsonb_build_array(account_provider_ids, operation_scopes,
    allow_automation_runs, expires_at, purpose)) > 1
)
SELECT g.id,
  row_number() OVER (PARTITION BY g.org_id, g.user_id, g.connection_id
    ORDER BY g.live DESC NULLS LAST, g.updated_at DESC, g.id DESC) AS rank,
  c.connection_id IS NOT NULL AS conflicting
FROM grants g
LEFT JOIN conflicts c USING (org_id, user_id, connection_id);
--> statement-breakpoint
UPDATE public.banking_agent_enablements AS grant_row
SET revoked_at = timezone('UTC', statement_timestamp())
FROM banking_workspace_grant_plan AS plan
WHERE grant_row.id = plan.id AND plan.rank = 1 AND plan.conflicting;
--> statement-breakpoint
DELETE FROM public.banking_agent_enablements AS grant_row
USING banking_workspace_grant_plan AS plan
WHERE grant_row.id = plan.id AND plan.rank > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_drafts_user_org" ON "agent_drafts" USING btree ("user_id","org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_banking_agent_enablements_unique" ON "banking_agent_enablements" USING btree ("org_id","user_id","connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_link_wallet_connections_owner" ON "link_wallet_connections" USING btree ("org_id","user_id") WHERE "link_wallet_connections"."retired_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_link_wallet_spends_intent" ON "link_wallet_spends" USING btree ("org_id","user_id","intent_id");--> statement-breakpoint
ALTER TABLE "agent_drafts" DROP COLUMN "agent_id";--> statement-breakpoint
ALTER TABLE "banking_agent_enablements" DROP COLUMN "agent_id";--> statement-breakpoint
ALTER TABLE "browser_user_action_requests" DROP COLUMN "agent_id";--> statement-breakpoint
ALTER TABLE "chat_thread_events" DROP COLUMN "agent_id";--> statement-breakpoint
ALTER TABLE "link_wallet_connections" DROP COLUMN "agent_id";--> statement-breakpoint
ALTER TABLE "link_wallet_spends" DROP COLUMN "agent_id";
--> statement-breakpoint
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
      id, user_id, org_id, seq_id, chat_thread_id, kind,
      title, pin_order, muted, hidden, selected_model,
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
