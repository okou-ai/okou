ALTER TABLE "teams_org_connections" DROP CONSTRAINT "teams_org_connections_teams_tenant_id_teams_org_installations_teams_tenant_id_fk";
--> statement-breakpoint
DROP INDEX "idx_teams_org_connections_owner";--> statement-breakpoint
ALTER TABLE "teams_org_connections" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_teams_org_connections_owner" ON "teams_org_connections" USING btree ("org_id","user_id");--> statement-breakpoint
ALTER TABLE "teams_org_connections" DROP COLUMN "legacy_installation_tenant_id";