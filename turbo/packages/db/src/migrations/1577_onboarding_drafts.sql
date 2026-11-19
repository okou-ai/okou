CREATE TABLE "onboarding_drafts" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"revision" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "onboarding_drafts_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
CREATE INDEX "idx_onboarding_drafts_expires_at" ON "onboarding_drafts" USING btree ("expires_at");