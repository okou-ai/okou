ALTER TABLE "slack_org_connections" DROP CONSTRAINT "slack_org_connections_slack_workspace_id_slack_org_installations_slack_workspace_id_fk";
--> statement-breakpoint
ALTER TABLE "chat_slack_context" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "slack_org_connections" ADD COLUMN "slack_workspace_name" text;--> statement-breakpoint
ALTER TABLE "slack_org_connections" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "slack_org_connections" ADD COLUMN "legacy_installation_workspace_id" varchar(255) GENERATED ALWAYS AS (CASE WHEN org_id IS NULL THEN slack_workspace_id ELSE NULL END) STORED;--> statement-breakpoint
ALTER TABLE "slack_org_connections" ADD CONSTRAINT "slack_org_connections_legacy_installation_workspace_id_slack_org_installations_slack_workspace_id_fk" FOREIGN KEY ("legacy_installation_workspace_id") REFERENCES "public"."slack_org_installations"("slack_workspace_id") ON DELETE no action ON UPDATE no action;