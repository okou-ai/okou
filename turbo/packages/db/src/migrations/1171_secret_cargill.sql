ALTER TABLE "official_workflow_catalog_releases" DROP CONSTRAINT "official_workflow_catalog_release_hash_format";--> statement-breakpoint
ALTER TABLE "official_workflow_catalog_state" DROP CONSTRAINT "official_workflow_catalog_state_authority";--> statement-breakpoint
ALTER TABLE "official_workflow_catalog_state" DROP CONSTRAINT "official_workflow_catalog_state_accepted_release_id_official_workflow_catalog_releases_id_fk";
--> statement-breakpoint
ALTER TABLE "official_workflow_reconciliation_work" DROP CONSTRAINT "official_workflow_reconciliation_work_requested_release_id_official_workflow_catalog_releases_id_fk";
--> statement-breakpoint
ALTER TABLE "official_workflow_catalog_releases" ALTER COLUMN "id" SET DATA TYPE varchar(128);--> statement-breakpoint
ALTER TABLE "official_workflow_catalog_state" ALTER COLUMN "authority" SET DATA TYPE varchar(64);--> statement-breakpoint
ALTER TABLE "official_workflow_catalog_state" ALTER COLUMN "authority" SET DEFAULT 'official';--> statement-breakpoint
ALTER TABLE "official_workflow_catalog_state" ALTER COLUMN "accepted_release_id" SET DATA TYPE varchar(128);--> statement-breakpoint
ALTER TABLE "official_workflow_definition_revisions" ALTER COLUMN "definition_name" SET DATA TYPE varchar(128);--> statement-breakpoint
ALTER TABLE "official_workflow_reconciliation_work" ALTER COLUMN "definition_name" SET DATA TYPE varchar(128);--> statement-breakpoint
ALTER TABLE "official_workflow_reconciliation_work" ALTER COLUMN "requested_release_id" SET DATA TYPE varchar(128);--> statement-breakpoint
ALTER TABLE "official_workflow_catalog_releases" ADD COLUMN "authority" varchar(64) DEFAULT 'official' NOT NULL;--> statement-breakpoint
ALTER TABLE "official_workflow_definition_revisions" ADD COLUMN "authority" varchar(64) DEFAULT 'official' NOT NULL;--> statement-breakpoint
ALTER TABLE "official_workflow_reconciliation_work" ADD COLUMN "authority" varchar(64) DEFAULT 'official' NOT NULL;--> statement-breakpoint
ALTER TABLE "official_workflow_catalog_releases" ADD CONSTRAINT "official_workflow_catalog_releases_authority_id_unique" UNIQUE("authority","id");--> statement-breakpoint
ALTER TABLE "official_workflow_catalog_state" ADD CONSTRAINT "official_workflow_catalog_state_release_fk" FOREIGN KEY ("authority","accepted_release_id") REFERENCES "public"."official_workflow_catalog_releases"("authority","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "official_workflow_reconciliation_work" ADD CONSTRAINT "official_workflow_reconciliation_work_release_fk" FOREIGN KEY ("authority","requested_release_id") REFERENCES "public"."official_workflow_catalog_releases"("authority","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_official_workflow_reconciliation_work_authority_due" ON "official_workflow_reconciliation_work" USING btree ("authority","available_at","definition_name");--> statement-breakpoint
ALTER TABLE "official_workflow_catalog_releases" ADD CONSTRAINT "official_workflow_catalog_release_authority" CHECK ("official_workflow_catalog_releases"."authority" = 'official' OR "official_workflow_catalog_releases"."authority" ~ '^test:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');--> statement-breakpoint
ALTER TABLE "official_workflow_catalog_releases" ADD CONSTRAINT "official_workflow_catalog_release_hash_format" CHECK ((
          "official_workflow_catalog_releases"."authority" = 'official'
          AND "official_workflow_catalog_releases"."id" ~ '^[0-9a-f]{64}$'
        ) OR (
          "official_workflow_catalog_releases"."authority" <> 'official'
          AND "official_workflow_catalog_releases"."id" = "official_workflow_catalog_releases"."authority" || '@' || right("official_workflow_catalog_releases"."id", 64)
          AND right("official_workflow_catalog_releases"."id", 64) ~ '^[0-9a-f]{64}$'
        ));--> statement-breakpoint
ALTER TABLE "official_workflow_catalog_state" ADD CONSTRAINT "official_workflow_catalog_state_authority" CHECK ("official_workflow_catalog_state"."authority" = 'official' OR "official_workflow_catalog_state"."authority" ~ '^test:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');--> statement-breakpoint
ALTER TABLE "official_workflow_definition_revisions" ADD CONSTRAINT "official_workflow_definition_revision_authority" CHECK ("official_workflow_definition_revisions"."authority" = 'official' OR "official_workflow_definition_revisions"."authority" ~ '^test:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');--> statement-breakpoint
ALTER TABLE "official_workflow_reconciliation_work" ADD CONSTRAINT "official_workflow_reconciliation_work_authority" CHECK ("official_workflow_reconciliation_work"."authority" = 'official' OR "official_workflow_reconciliation_work"."authority" ~ '^test:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');
