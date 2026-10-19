ALTER TABLE "chat_thread_events" ADD COLUMN "hidden" boolean;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "hidden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "official_workflow_catalog_releases" ADD COLUMN "hidden_thread_definition_names" jsonb DEFAULT '[]'::jsonb NOT NULL;