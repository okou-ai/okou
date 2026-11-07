ALTER TABLE "browser_chat_sessions" ADD COLUMN "tab_order" jsonb;--> statement-breakpoint
ALTER TABLE "browser_session_instances" ADD COLUMN "tab_order" jsonb;