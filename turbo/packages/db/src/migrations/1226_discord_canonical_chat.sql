-- Expand existing checks without scanning while holding exclusive table locks.
-- Their validation runs in the next migration transaction.
CREATE TABLE "discord_chat_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"ingress_id" uuid,
	"chat_event_id" uuid,
	"chat_thread_id" uuid,
	"route_id" uuid,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"content" text NOT NULL,
	"parts" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp,
	"retry_at" timestamp,
	"delivered_at" timestamp,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "discord_chat_deliveries_source_check" CHECK (("discord_chat_deliveries"."chat_event_id" IS NOT NULL AND "discord_chat_deliveries"."ingress_id" IS NULL AND "discord_chat_deliveries"."chat_thread_id" IS NOT NULL AND "discord_chat_deliveries"."route_id" IS NOT NULL) OR ("discord_chat_deliveries"."chat_event_id" IS NULL AND "discord_chat_deliveries"."ingress_id" IS NOT NULL AND "discord_chat_deliveries"."chat_thread_id" IS NULL AND "discord_chat_deliveries"."route_id" IS NULL)),
	CONSTRAINT "discord_chat_deliveries_status_check" CHECK ("discord_chat_deliveries"."status" IN ('pending', 'delivered', 'failed', 'suppressed'))
);
--> statement-breakpoint
CREATE TABLE "discord_gateway_receipts" (
	"event_digest" varchar(64) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_run_attribution" DROP CONSTRAINT "billing_run_attribution_source_check";--> statement-breakpoint
ALTER TABLE "chat_events" DROP CONSTRAINT "chat_events_context_type_check";--> statement-breakpoint
-- Attach the online-built index as identity metadata; no index rebuild or table scan.
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_id_thread_unique" UNIQUE USING INDEX "chat_events_id_thread_unique";--> statement-breakpoint
ALTER TABLE "discord_chat_deliveries" ADD CONSTRAINT "discord_chat_deliveries_connection_id_discord_org_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."discord_org_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_chat_deliveries" ADD CONSTRAINT "discord_chat_deliveries_ingress_id_discord_chat_ingress_id_fk" FOREIGN KEY ("ingress_id") REFERENCES "public"."discord_chat_ingress"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_chat_deliveries" ADD CONSTRAINT "discord_chat_deliveries_chat_event_id_chat_events_id_fk" FOREIGN KEY ("chat_event_id") REFERENCES "public"."chat_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_chat_deliveries" ADD CONSTRAINT "discord_chat_deliveries_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_chat_deliveries" ADD CONSTRAINT "discord_chat_deliveries_route_id_discord_chat_thread_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."discord_chat_thread_routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_chat_deliveries" ADD CONSTRAINT "discord_chat_deliveries_event_thread_fk" FOREIGN KEY ("chat_event_id","chat_thread_id") REFERENCES "public"."chat_events"("id","chat_thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_chat_deliveries" ADD CONSTRAINT "discord_chat_deliveries_connection_owner_fk" FOREIGN KEY ("connection_id","user_id") REFERENCES "public"."discord_org_connections"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_chat_deliveries" ADD CONSTRAINT "discord_chat_deliveries_route_owner_fk" FOREIGN KEY ("route_id","connection_id","chat_thread_id") REFERENCES "public"."discord_chat_thread_routes"("id","connection_id","chat_thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_chat_deliveries" ADD CONSTRAINT "discord_chat_deliveries_ingress_owner_fk" FOREIGN KEY ("ingress_id","connection_id") REFERENCES "public"."discord_chat_ingress"("id","connection_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_discord_chat_deliveries_event" ON "discord_chat_deliveries" USING btree ("chat_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_discord_chat_deliveries_ingress" ON "discord_chat_deliveries" USING btree ("ingress_id");--> statement-breakpoint
CREATE INDEX "idx_discord_chat_deliveries_pending" ON "discord_chat_deliveries" USING btree ("status","last_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_discord_chat_deliveries_owner" ON "discord_chat_deliveries" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_discord_chat_deliveries_connection" ON "discord_chat_deliveries" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "idx_discord_chat_deliveries_thread" ON "discord_chat_deliveries" USING btree ("chat_thread_id");--> statement-breakpoint
CREATE INDEX "idx_discord_chat_deliveries_route" ON "discord_chat_deliveries" USING btree ("route_id");--> statement-breakpoint
ALTER TABLE "billing_run_attribution" ADD CONSTRAINT "billing_run_attribution_source_check" CHECK ("billing_run_attribution"."source" IN ('chat', 'automation', 'slack', 'discord', 'teams', 'telegram', 'email', 'agentphone', 'github', 'agent', 'other')) NOT VALID;--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_context_type_check" CHECK ("chat_events"."context_type" IN (
          'web',
          'slack',
          'discord',
          'feishu',
          'teams',
          'telegram',
          'github',
          'agentphone',
          'automation',
          'goal',
          'agent_run'
        )) NOT VALID;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION billing_usage_source(trigger_source text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN trigger_source = 'web' THEN 'chat'
    WHEN trigger_source IN ('automation-schedule', 'automation-event', 'goal') THEN 'automation'
    WHEN trigger_source IN ('slack', 'discord', 'teams', 'telegram', 'email', 'agentphone', 'github', 'agent') THEN trigger_source
    ELSE 'other'
  END
$$;
