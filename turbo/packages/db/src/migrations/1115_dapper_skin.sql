ALTER TABLE "chat_thread_events" ADD COLUMN "model_settings" jsonb;--> statement-breakpoint
ALTER TABLE "chat_thread_events" ADD COLUMN "model_settings_patch" jsonb;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "model_settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "org_members_metadata" ADD COLUMN "model_settings" jsonb DEFAULT '{}'::jsonb NOT NULL;