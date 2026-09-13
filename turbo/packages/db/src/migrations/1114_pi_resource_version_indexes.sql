CREATE TABLE "pi_resource_version_indexes" (
	"storage_version_id" varchar(64) NOT NULL,
	"extractor_version" integer NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"projection" jsonb,
	"source_archive_size" bigint,
	"projection_hash" varchar(64),
	"lease_id" uuid,
	"lease_expires_at" timestamp,
	"available_at" timestamp DEFAULT now() NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pi_resource_version_indexes_pk" PRIMARY KEY("storage_version_id","extractor_version"),
	CONSTRAINT "pi_resource_version_indexes_status_check" CHECK ("pi_resource_version_indexes"."status" IN ('pending', 'running', 'ready', 'unindexable')),
	CONSTRAINT "pi_resource_version_indexes_projection_check" CHECK (("pi_resource_version_indexes"."status" = 'ready' AND "pi_resource_version_indexes"."projection" IS NOT NULL AND "pi_resource_version_indexes"."projection_hash" IS NOT NULL AND "pi_resource_version_indexes"."source_archive_size" IS NOT NULL) OR ("pi_resource_version_indexes"."status" <> 'ready' AND "pi_resource_version_indexes"."projection" IS NULL AND "pi_resource_version_indexes"."projection_hash" IS NULL)),
	CONSTRAINT "pi_resource_version_indexes_lease_check" CHECK (("pi_resource_version_indexes"."status" = 'running' AND "pi_resource_version_indexes"."lease_id" IS NOT NULL AND "pi_resource_version_indexes"."lease_expires_at" IS NOT NULL) OR ("pi_resource_version_indexes"."status" <> 'running' AND "pi_resource_version_indexes"."lease_id" IS NULL AND "pi_resource_version_indexes"."lease_expires_at" IS NULL)),
	CONSTRAINT "pi_resource_version_indexes_size_check" CHECK ("pi_resource_version_indexes"."source_archive_size" IS NULL OR "pi_resource_version_indexes"."source_archive_size" >= 0),
	CONSTRAINT "pi_resource_version_indexes_attempt_check" CHECK ("pi_resource_version_indexes"."attempt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "pi_resource_version_indexes" ADD CONSTRAINT "pi_resource_version_indexes_version_fk" FOREIGN KEY ("storage_version_id") REFERENCES "public"."storage_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pi_resource_version_indexes_pending_idx" ON "pi_resource_version_indexes" USING btree ("extractor_version","available_at") WHERE "pi_resource_version_indexes"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "pi_resource_version_indexes_lease_idx" ON "pi_resource_version_indexes" USING btree ("extractor_version","lease_expires_at") WHERE "pi_resource_version_indexes"."status" = 'running';