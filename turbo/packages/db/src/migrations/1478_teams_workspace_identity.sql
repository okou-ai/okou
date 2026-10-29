ALTER TABLE "teams_org_connections" DROP CONSTRAINT "teams_org_connections_teams_tenant_id_teams_org_installations_teams_tenant_id_fk";
--> statement-breakpoint
ALTER TABLE "teams_org_connections" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "teams_org_connections" ADD COLUMN "legacy_installation_tenant_id" varchar(255) GENERATED ALWAYS AS (CASE WHEN org_id IS NULL THEN teams_tenant_id ELSE NULL END) STORED;--> statement-breakpoint
ALTER TABLE "teams_org_connections" ADD CONSTRAINT "teams_org_connections_teams_tenant_id_teams_org_installations_teams_tenant_id_fk" FOREIGN KEY ("legacy_installation_tenant_id") REFERENCES "public"."teams_org_installations"("teams_tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_teams_org_connections_owner" ON "teams_org_connections" USING btree ("org_id","user_id") WHERE "teams_org_connections"."org_id" IS NOT NULL;