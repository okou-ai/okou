ALTER TABLE "chat_thread_events" ADD COLUMN "muted" boolean;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "muted" boolean DEFAULT false NOT NULL;