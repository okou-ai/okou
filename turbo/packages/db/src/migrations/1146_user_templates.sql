CREATE TABLE "user_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"visibility" varchar(16) DEFAULT 'private' NOT NULL,
	"title" text NOT NULL,
	"source_storage_key" text NOT NULL,
	"source_filename" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_user_templates_visibility" CHECK ("user_templates"."visibility" IN ('private', 'organization'))
);
--> statement-breakpoint
CREATE INDEX "idx_user_templates_owner_created" ON "user_templates" USING btree ("org_id","owner_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_user_templates_org_visible" ON "user_templates" USING btree ("org_id","created_at" DESC NULLS LAST) WHERE "user_templates"."visibility" = 'organization';