CREATE TABLE "feishu_official_app_tickets" (
	"app_id" text PRIMARY KEY NOT NULL,
	"encrypted_ticket" text NOT NULL,
	"event_timestamp" bigint NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "idx_feishu_org_installations_org_platform";--> statement-breakpoint
DROP INDEX "idx_feishu_org_installations_app";--> statement-breakpoint
ALTER TABLE "feishu_org_installations" ADD COLUMN "installation_type" text DEFAULT 'custom' NOT NULL;--> statement-breakpoint
ALTER TABLE "feishu_org_installations" ADD COLUMN "official_event_timestamp" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_feishu_org_installations_official_tenant" ON "feishu_org_installations" USING btree ("app_id","feishu_tenant_key") WHERE "feishu_org_installations"."installation_type" = 'official';--> statement-breakpoint
CREATE UNIQUE INDEX "idx_feishu_org_installations_org_platform" ON "feishu_org_installations" USING btree ("org_id","platform","installation_type");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_feishu_org_installations_app" ON "feishu_org_installations" USING btree ("app_id") WHERE "feishu_org_installations"."installation_type" = 'custom';--> statement-breakpoint
ALTER TABLE "feishu_org_installations" ADD CONSTRAINT "chk_feishu_installation_type" CHECK ("feishu_org_installations"."installation_type" IN ('custom', 'official') AND ("feishu_org_installations"."installation_type" = 'custom' OR "feishu_org_installations"."platform" = 'feishu'));