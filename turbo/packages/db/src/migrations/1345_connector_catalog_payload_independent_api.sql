ALTER TABLE "connector_catalog_entries" ALTER COLUMN "payload" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" ALTER COLUMN "label" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" ALTER COLUMN "description" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" ALTER COLUMN "category" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" ALTER COLUMN "icon" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" ALTER COLUMN "tags" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" ALTER COLUMN "generation" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" ALTER COLUMN "auth_methods" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" ALTER COLUMN "skill" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" ALTER COLUMN "firewall" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_catalog_entries" ALTER COLUMN "permission_summary" SET NOT NULL;