ALTER TABLE "chat_threads" ADD CONSTRAINT "uq_chat_threads_id_user" UNIQUE("id","user_id");--> statement-breakpoint
CREATE TABLE "chat_discord_context" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"guild_id" text,
	"channel_id" text NOT NULL,
	"message_id" text NOT NULL,
	"bot_user_id" text NOT NULL,
	"public_brand" text NOT NULL,
	"conversation_context" text,
	"message_text" text NOT NULL,
	"message_files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"message_assets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mention_display_names" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sender_display_name" text,
	"sender_user_id" text NOT NULL,
	"channel_type" text NOT NULL,
	"thread_id" text,
	"destination_channel_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "discord_chat_ingress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"route_id" uuid,
	"event_id" varchar(255) NOT NULL,
	"message_id" varchar(255) NOT NULL,
	"payload" text NOT NULL,
	"public_brand" text NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"processing_attempt_count" integer DEFAULT 0 NOT NULL,
	"claim_token" uuid,
	"claimed_at" timestamp,
	"retry_at" timestamp,
	"last_error_class" varchar(128),
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_discord_chat_ingress_event" UNIQUE("event_id"),
	CONSTRAINT "uq_discord_chat_ingress_message" UNIQUE("message_id"),
	CONSTRAINT "uq_discord_chat_ingress_connection" UNIQUE("id","connection_id"),
	CONSTRAINT "chk_discord_chat_ingress_status" CHECK ("discord_chat_ingress"."status" IN ('pending', 'processing', 'retryable', 'processed', 'terminal')),
	CONSTRAINT "chk_discord_chat_ingress_retry_count" CHECK ("discord_chat_ingress"."retry_count" >= 0),
	CONSTRAINT "chk_discord_chat_ingress_processing_attempt_count" CHECK ("discord_chat_ingress"."processing_attempt_count" >= 0),
	CONSTRAINT "chk_discord_chat_ingress_claim" CHECK (("discord_chat_ingress"."status" = 'processing' AND "discord_chat_ingress"."claim_token" IS NOT NULL AND "discord_chat_ingress"."claimed_at" IS NOT NULL) OR ("discord_chat_ingress"."status" <> 'processing' AND "discord_chat_ingress"."claim_token" IS NULL AND "discord_chat_ingress"."claimed_at" IS NULL))
);--> statement-breakpoint
CREATE TABLE "discord_chat_thread_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"channel_id" varchar(255) NOT NULL,
	"session_key" text NOT NULL,
	"user_id" text NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"destination_channel_id" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_discord_chat_thread_routes_session" UNIQUE("connection_id","channel_id","session_key","user_id"),
	CONSTRAINT "uq_discord_chat_thread_routes_connection" UNIQUE("id","connection_id"),
	CONSTRAINT "uq_discord_chat_thread_routes_context" UNIQUE("id","connection_id","chat_thread_id")
);--> statement-breakpoint
CREATE TABLE "discord_org_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" varchar(255) NOT NULL,
	"discord_user_id" varchar(255) NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_discord_org_connections_guild_sender" UNIQUE("guild_id","discord_user_id"),
	CONSTRAINT "uq_discord_org_connections_guild_user" UNIQUE("guild_id","user_id"),
	CONSTRAINT "uq_discord_org_connections_owner" UNIQUE("id","user_id"),
	CONSTRAINT "uq_discord_org_connections_sender_owner" UNIQUE("id","discord_user_id","user_id")
);--> statement-breakpoint
CREATE TABLE "discord_org_installations" (
	"guild_id" varchar(255) PRIMARY KEY NOT NULL,
	"guild_name" varchar(255),
	"org_id" text NOT NULL,
	"bot_user_id" varchar(255) NOT NULL,
	"installed_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_discord_org_installations_org" UNIQUE("org_id")
);--> statement-breakpoint
CREATE TABLE "discord_user_agent_preferences" (
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"selected_agent_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "discord_user_agent_preferences_user_id_org_id_pk" PRIMARY KEY("user_id","org_id")
);--> statement-breakpoint
CREATE TABLE "discord_user_dm_preferences" (
	"discord_user_id" varchar(255) PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "chat_discord_context" ADD CONSTRAINT "chat_discord_context_route_owner_fk" FOREIGN KEY ("route_id","connection_id","chat_thread_id") REFERENCES "public"."discord_chat_thread_routes"("id","connection_id","chat_thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_chat_ingress" ADD CONSTRAINT "discord_chat_ingress_connection_id_discord_org_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."discord_org_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_chat_ingress" ADD CONSTRAINT "discord_chat_ingress_route_connection_fk" FOREIGN KEY ("route_id","connection_id") REFERENCES "public"."discord_chat_thread_routes"("id","connection_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_chat_thread_routes" ADD CONSTRAINT "discord_chat_thread_routes_connection_owner_fk" FOREIGN KEY ("connection_id","user_id") REFERENCES "public"."discord_org_connections"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_chat_thread_routes" ADD CONSTRAINT "discord_chat_thread_routes_chat_owner_fk" FOREIGN KEY ("chat_thread_id","user_id") REFERENCES "public"."chat_threads"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_org_connections" ADD CONSTRAINT "discord_org_connections_guild_id_discord_org_installations_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."discord_org_installations"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_user_agent_preferences" ADD CONSTRAINT "discord_user_agent_preferences_selected_agent_id_agents_id_fk" FOREIGN KEY ("selected_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_user_agent_preferences" ADD CONSTRAINT "discord_user_agent_preferences_connection_owner_fk" FOREIGN KEY ("connection_id","user_id") REFERENCES "public"."discord_org_connections"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_user_dm_preferences" ADD CONSTRAINT "discord_user_dm_preferences_sender_owner_fk" FOREIGN KEY ("connection_id","discord_user_id","user_id") REFERENCES "public"."discord_org_connections"("id","discord_user_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chat_discord_context_route" ON "chat_discord_context" USING btree ("route_id");--> statement-breakpoint
CREATE INDEX "idx_chat_discord_context_chat" ON "chat_discord_context" USING btree ("chat_thread_id");--> statement-breakpoint
CREATE INDEX "idx_discord_chat_ingress_connection" ON "discord_chat_ingress" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "idx_discord_chat_ingress_route" ON "discord_chat_ingress" USING btree ("route_id");--> statement-breakpoint
CREATE INDEX "idx_discord_chat_ingress_retry_sweep" ON "discord_chat_ingress" USING btree ("status","retry_at","updated_at");--> statement-breakpoint
CREATE INDEX "idx_discord_chat_thread_routes_chat" ON "discord_chat_thread_routes" USING btree ("chat_thread_id");--> statement-breakpoint
CREATE INDEX "idx_discord_org_connections_user" ON "discord_org_connections" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_discord_org_connections_sender" ON "discord_org_connections" USING btree ("discord_user_id");--> statement-breakpoint
CREATE INDEX "idx_discord_org_installations_installer_guild" ON "discord_org_installations" USING btree ("installed_by_user_id","guild_id");--> statement-breakpoint
CREATE INDEX "idx_discord_user_agent_preferences_connection" ON "discord_user_agent_preferences" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "idx_discord_user_dm_preferences_connection" ON "discord_user_dm_preferences" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "idx_discord_user_dm_preferences_user" ON "discord_user_dm_preferences" USING btree ("user_id");