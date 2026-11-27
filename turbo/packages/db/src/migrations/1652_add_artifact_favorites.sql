CREATE TABLE "artifact_favorites" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"artifact_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_favorites_org_id_user_id_artifact_id_pk" PRIMARY KEY("org_id","user_id","artifact_id")
);
--> statement-breakpoint
CREATE INDEX "idx_artifact_favorites_owner_created" ON "artifact_favorites" USING btree ("org_id","user_id","created_at" DESC NULLS LAST,"artifact_id" DESC NULLS LAST);