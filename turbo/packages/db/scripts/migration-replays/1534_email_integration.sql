-- Preserve 1534's SQL/hash in migration history, but avoid scanning chat_events
-- while holding ACCESS EXCLUSIVE. Migration 1535 validates after this commits.
CREATE TABLE "chat_email_context" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"user_link_id" uuid NOT NULL,
	"email_message_id" uuid NOT NULL,
	"message_text" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_channel_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_email_id" text NOT NULL,
	"sender" text NOT NULL,
	"message_id" text NOT NULL,
	"subject" text NOT NULL,
	"text" text NOT NULL,
	"in_reply_to" text,
	"references" text[] DEFAULT '{}' NOT NULL,
	"attachment_names" text[] DEFAULT '{}' NOT NULL,
	"attachment_ids" text[] DEFAULT '{}' NOT NULL,
	"authenticated" boolean NOT NULL,
	"route_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_chat_thread_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_link_id" uuid NOT NULL,
	"root_message_id" text NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_user_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_address" text NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"disconnected_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_events" DROP CONSTRAINT "chat_events_context_type_check";--> statement-breakpoint
ALTER TABLE "chat_email_context" ADD CONSTRAINT "chat_email_context_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_channel_messages" ADD CONSTRAINT "email_channel_messages_route_id_email_chat_thread_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."email_chat_thread_routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_chat_thread_routes" ADD CONSTRAINT "email_chat_thread_routes_user_link_id_email_user_links_id_fk" FOREIGN KEY ("user_link_id") REFERENCES "public"."email_user_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_chat_thread_routes" ADD CONSTRAINT "email_chat_thread_routes_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_email_context_thread_idx" ON "chat_email_context" USING btree ("chat_thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_channel_messages_provider_unique" ON "email_channel_messages" USING btree ("provider_email_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_channel_messages_sender_message_unique" ON "email_channel_messages" USING btree ("sender","message_id");--> statement-breakpoint
CREATE INDEX "email_channel_messages_route_idx" ON "email_channel_messages" USING btree ("route_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_chat_thread_routes_sender_root_unique" ON "email_chat_thread_routes" USING btree ("user_link_id","root_message_id");--> statement-breakpoint
CREATE INDEX "email_chat_thread_routes_thread_idx" ON "email_chat_thread_routes" USING btree ("chat_thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_user_links_address_unique" ON "email_user_links" USING btree ("email_address");--> statement-breakpoint
CREATE INDEX "email_user_links_member_idx" ON "email_user_links" USING btree ("user_id","org_id");--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_context_type_check" CHECK ("chat_events"."context_type" IN (
          'web',
          'slack',
          'discord', 'wechat',
          'feishu',
          'teams',
          'telegram',
          'agentphone',
          'email',
          'automation',
          'agent_run'
        )) NOT VALID;
