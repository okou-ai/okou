ALTER TABLE "agents" ADD COLUMN "instructions_bundle" jsonb;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "content_bundle" jsonb;