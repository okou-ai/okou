CREATE TABLE "artifact_catalog_favorites" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"artifact_id" uuid NOT NULL,
	CONSTRAINT "artifact_catalog_favorites_org_id_user_id_artifact_id_pk" PRIMARY KEY("org_id","user_id","artifact_id")
);
--> statement-breakpoint
ALTER TABLE "artifact_catalog_favorites" ADD CONSTRAINT "artifact_catalog_favorites_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_catalog_favorites_artifact_idx" ON "artifact_catalog_favorites" USING btree ("artifact_id");