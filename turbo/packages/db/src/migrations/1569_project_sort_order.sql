ALTER TYPE "public"."project_event_kind" ADD VALUE 'sort_updated';--> statement-breakpoint
ALTER TABLE "project_events" ADD COLUMN "sort_order" text;--> statement-breakpoint
ALTER TABLE "project_events" ADD COLUMN "reorder_target_id" uuid;--> statement-breakpoint
ALTER TABLE "project_events" ADD COLUMN "reorder_side" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "sort_order" text;