CREATE TABLE "artifact_user_shares" (
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"artifact_id" uuid NOT NULL,
	"email" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_user_shares_pk" PRIMARY KEY("user_id","org_id","artifact_id")
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"storage_key" text,
	"filename" text,
	"content_type" text,
	"size_bytes" bigint,
	"checksum_sha256" varchar(64),
	"origin" varchar(16) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "files_origin_check" CHECK ("files"."origin" IN ('user', 'agent', 'system')),
	CONSTRAINT "files_org_id_nonempty" CHECK (length("files"."org_id") > 0)
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "visibility" varchar(16) DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "category" varchar(32);--> statement-breakpoint
ALTER TABLE "artifact_user_shares" ADD CONSTRAINT "artifact_user_shares_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_user_shares_artifact_idx" ON "artifact_user_shares" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "files_owner_created_idx" ON "files" USING btree ("org_id","owner_user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "files"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "files_storage_key_idx" ON "files" USING btree ("storage_key") WHERE "files"."storage_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "artifacts_author_category_created_idx" ON "artifacts" USING btree ("org_id","author_user_id","category","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "artifacts"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_visibility_check" CHECK ("artifacts"."visibility" IN ('private', 'organization', 'public'));