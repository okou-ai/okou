ALTER TABLE "connector_catalog_entries" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" ADD COLUMN "auth_methods" jsonb;--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" ADD COLUMN "firewall" jsonb;--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" ADD COLUMN "storage_name" text;--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" ADD COLUMN "version_id" text;--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" ADD COLUMN "mcp_endpoint" text;