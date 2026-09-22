CREATE TABLE "browser_user_action_requests" (
	"request_token_hash" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"status" varchar(20) NOT NULL,
	"provider_session_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"apply_started_at" timestamp,
	"completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "browser_user_action_requests" ADD CONSTRAINT "browser_user_action_requests_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_browser_user_action_requests_owner" ON "browser_user_action_requests" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_browser_user_action_requests_user" ON "browser_user_action_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_browser_user_action_requests_thread" ON "browser_user_action_requests" USING btree ("chat_thread_id");--> statement-breakpoint
CREATE INDEX "idx_browser_user_action_requests_provider_state" ON "browser_user_action_requests" USING btree ("provider_session_id","status");