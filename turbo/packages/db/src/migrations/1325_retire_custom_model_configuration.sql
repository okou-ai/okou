DROP TABLE "org_model_policies";--> statement-breakpoint
DROP TABLE "model_provider_surfaces";--> statement-breakpoint
DROP TABLE "model_provider_connections";--> statement-breakpoint
ALTER TABLE "org_metadata" DROP CONSTRAINT "chk_org_metadata_model_mode";--> statement-breakpoint
ALTER TABLE "org_metadata" DROP COLUMN "model_mode";