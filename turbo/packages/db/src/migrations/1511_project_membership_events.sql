ALTER TYPE "public"."chat_thread_event_kind" ADD VALUE 'project_updated';--> statement-breakpoint
ALTER TABLE "project_events" ADD COLUMN "from_thread_id" uuid;