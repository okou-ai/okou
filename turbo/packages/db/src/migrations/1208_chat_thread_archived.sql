ALTER TYPE "public"."chat_thread_event_kind" ADD VALUE 'archived';--> statement-breakpoint
ALTER TYPE "public"."chat_thread_event_kind" ADD VALUE 'unarchived';--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "archived" boolean DEFAULT false NOT NULL;