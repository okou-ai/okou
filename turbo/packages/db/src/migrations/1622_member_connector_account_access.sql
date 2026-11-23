ALTER TABLE "connectors" ADD COLUMN "chat_access_allowed" boolean;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "chat_access_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "chk_connectors_chat_access_expiry" CHECK ("connectors"."chat_access_expires_at" IS NULL OR "connectors"."chat_access_allowed" IS TRUE);