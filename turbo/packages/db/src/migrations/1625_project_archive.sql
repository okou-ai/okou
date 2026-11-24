ALTER TABLE "project_events" ADD COLUMN "archived" boolean;--> statement-breakpoint
ALTER TABLE "project_events" ADD COLUMN "last_archived_at" timestamp;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "archived" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "last_archived_at" timestamp;