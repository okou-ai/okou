ALTER TABLE "connector_catalog_entries" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" ADD COLUMN "icon" jsonb;--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" ADD COLUMN "tags" text[];--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" ADD COLUMN "generation" text[];--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" ADD COLUMN "auth_methods" jsonb;--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" ADD COLUMN "mcp" jsonb;--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" ADD COLUMN "skill" jsonb;--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" ADD COLUMN "firewall" jsonb;--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" ADD COLUMN "permission_summary" jsonb;