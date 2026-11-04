CREATE TABLE "registry_resource_archives" (
	"resource_id" text NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"archive_bytes" bigint NOT NULL,
	"version_id" varchar(64) NOT NULL,
	"file_count" integer NOT NULL,
	"total_bytes" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "registry_resource_archives_resource_id_sha256_pk" PRIMARY KEY("resource_id","sha256"),
	CONSTRAINT "chk_registry_resource_archive_id" CHECK ("registry_resource_archives"."resource_id" ~ '^(skill|template|design-system|color-system|image-style):[a-z0-9][a-z0-9-]*$'),
	CONSTRAINT "chk_registry_resource_archive_digests" CHECK ("registry_resource_archives"."sha256" ~ '^[a-f0-9]{64}$' AND "registry_resource_archives"."version_id" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "chk_registry_resource_archive_limits" CHECK ("registry_resource_archives"."archive_bytes" BETWEEN 1 AND 33554432 AND "registry_resource_archives"."total_bytes" BETWEEN 0 AND 33554432 AND "registry_resource_archives"."file_count" BETWEEN 1 AND 501)
);
--> statement-breakpoint
CREATE TABLE "registry_resource_heads" (
	"resource_id" text PRIMARY KEY NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_registry_resource_head_id" CHECK ("registry_resource_heads"."resource_id" ~ '^template:html-ppt-[a-z0-9]+(-[a-z0-9]+)*-runbook$')
);
--> statement-breakpoint
ALTER TABLE "registry_resource_heads" ADD CONSTRAINT "fk_registry_resource_head_archive" FOREIGN KEY ("resource_id","sha256") REFERENCES "public"."registry_resource_archives"("resource_id","sha256") ON DELETE no action ON UPDATE no action;