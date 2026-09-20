ALTER TABLE "hosted_deployments" ALTER COLUMN "deployment_version" SET DEFAULT 1;--> statement-breakpoint
ALTER TABLE "hosted_sites" ALTER COLUMN "next_deployment_version" SET DEFAULT 2;--> statement-breakpoint
ALTER TABLE "private_hosted_deployments" ALTER COLUMN "deployment_version" SET DEFAULT 1;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_hosted_deployments_site_manifest_version" ON "hosted_deployments" USING btree ("site_id",(("manifest"->>'deploymentVersion')::integer));--> statement-breakpoint
CREATE UNIQUE INDEX "idx_private_hosted_deployments_site_manifest_version" ON "private_hosted_deployments" USING btree ("site_id",(("manifest"->>'deploymentVersion')::integer));