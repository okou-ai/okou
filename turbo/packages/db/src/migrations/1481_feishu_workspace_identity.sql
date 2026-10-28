ALTER TABLE "feishu_org_connections" DROP CONSTRAINT "feishu_org_connections_installation_id_feishu_org_installations_id_fk";
--> statement-breakpoint
ALTER TABLE "feishu_org_connections" ALTER COLUMN "installation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "feishu_org_connections" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "feishu_org_connections" ADD COLUMN "legacy_installation_id" uuid GENERATED ALWAYS AS (CASE WHEN org_id IS NULL THEN installation_id ELSE NULL END) STORED;--> statement-breakpoint
ALTER TABLE "feishu_org_connections" ADD CONSTRAINT "feishu_org_connections_installation_id_feishu_org_installations_id_fk" FOREIGN KEY ("legacy_installation_id") REFERENCES "public"."feishu_org_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_feishu_org_connections_owner" ON "feishu_org_connections" USING btree ("org_id","user_id") WHERE "feishu_org_connections"."org_id" IS NOT NULL;