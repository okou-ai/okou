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
ALTER TABLE "agent_drafts" DROP COLUMN "agent_id";--> statement-breakpoint
ALTER TABLE "banking_agent_enablements" DROP COLUMN "agent_id";--> statement-breakpoint
ALTER TABLE "browser_user_action_requests" DROP COLUMN "agent_id";--> statement-breakpoint
ALTER TABLE "chat_thread_events" RENAME COLUMN "agent_id" TO "event_executor_id";--> statement-breakpoint
ALTER TABLE "link_wallet_connections" DROP COLUMN "agent_id";--> statement-breakpoint
ALTER TABLE "link_wallet_spends" DROP COLUMN "agent_id";
