ALTER TABLE "connectors" ADD COLUMN "member_access_allowed" boolean;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "member_access_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "chk_connectors_member_access_expiry" CHECK ("connectors"."member_access_expires_at" IS NULL OR "connectors"."member_access_allowed" IS TRUE);