CREATE TABLE "feature_guide_editions" (
	"id" text PRIMARY KEY NOT NULL,
	"published_revision_id" uuid,
	"published_at" timestamp with time zone,
	"published_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_guide_receipts" (
	"user_id" text NOT NULL,
	"edition_id" text NOT NULL,
	"revision_id" uuid NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_guide_receipts_user_id_edition_id_pk" PRIMARY KEY("user_id","edition_id")
);
--> statement-breakpoint
CREATE TABLE "feature_guide_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"edition_id" text NOT NULL,
	"content" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_guide_revision_edition_identity" UNIQUE("edition_id","id"),
	CONSTRAINT "feature_guide_revision_content_hash" UNIQUE("edition_id","content_hash")
);
--> statement-breakpoint
ALTER TABLE "feature_guide_editions" ADD CONSTRAINT "feature_guide_published_revision_fk" FOREIGN KEY ("id","published_revision_id") REFERENCES "public"."feature_guide_revisions"("edition_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_guide_receipts" ADD CONSTRAINT "feature_guide_receipt_revision_fk" FOREIGN KEY ("edition_id","revision_id") REFERENCES "public"."feature_guide_revisions"("edition_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_guide_revisions" ADD CONSTRAINT "feature_guide_revisions_edition_id_feature_guide_editions_id_fk" FOREIGN KEY ("edition_id") REFERENCES "public"."feature_guide_editions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_feature_guide_editions_published" ON "feature_guide_editions" USING btree ("published_at");