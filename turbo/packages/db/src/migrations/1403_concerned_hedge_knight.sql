CREATE TABLE "chat_wechat_context" (
	"id" uuid PRIMARY KEY NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"generation" uuid NOT NULL,
	"sender_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"message_id" text NOT NULL,
	"context_token_ciphertext" text NOT NULL,
	"quoted_text" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wechat_chat_thread_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wechat_connect_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"qr_ciphertext" text NOT NULL,
	"base_url" text NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wechat_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"sender_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"generation" uuid DEFAULT gen_random_uuid() NOT NULL,
	"base_url" text NOT NULL,
	"token_ciphertext" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"updates_cursor" text DEFAULT '' NOT NULL,
	"pending_batch_ciphertext" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_run_attribution" DROP CONSTRAINT "billing_run_attribution_source_check";--> statement-breakpoint
ALTER TABLE "chat_events" DROP CONSTRAINT "chat_events_context_type_check";--> statement-breakpoint
ALTER TABLE "chat_wechat_context" ADD CONSTRAINT "chat_wechat_context_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_wechat_context" ADD CONSTRAINT "chat_wechat_context_connection_id_wechat_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."wechat_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wechat_chat_thread_routes" ADD CONSTRAINT "wechat_chat_thread_routes_connection_id_wechat_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."wechat_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wechat_chat_thread_routes" ADD CONSTRAINT "wechat_chat_thread_routes_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_wechat_context_thread_idx" ON "chat_wechat_context" USING btree ("chat_thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wechat_chat_thread_routes_connection_idx" ON "wechat_chat_thread_routes" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "wechat_chat_thread_routes_thread_idx" ON "wechat_chat_thread_routes" USING btree ("chat_thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wechat_connect_attempts_owner_idx" ON "wechat_connect_attempts" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wechat_connections_owner_idx" ON "wechat_connections" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wechat_connections_sender_idx" ON "wechat_connections" USING btree ("sender_id");--> statement-breakpoint
ALTER TABLE "billing_run_attribution" ADD CONSTRAINT "billing_run_attribution_source_check" CHECK ("billing_run_attribution"."source" IN ('chat', 'automation', 'slack', 'discord', 'wechat', 'teams', 'telegram', 'email', 'agentphone', 'github', 'agent', 'other')) NOT VALID;--> statement-breakpoint
ALTER TABLE "chat_events" ADD CONSTRAINT "chat_events_context_type_check" CHECK ("chat_events"."context_type" IN (
          'web',
          'slack',
          'discord', 'wechat',
          'feishu',
          'teams',
          'telegram',
          'agentphone',
          'automation',
          'agent_run'
        )) NOT VALID;
