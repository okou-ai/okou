ALTER TYPE "public"."project_event_kind" ADD VALUE 'archived';--> statement-breakpoint
ALTER TYPE "public"."project_event_kind" ADD VALUE 'restored';--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "archived_at" timestamp;