CREATE TABLE "integration_artifact_deliveries" (
	"delivery_key" text PRIMARY KEY NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"source_content_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "integration_artifact_deliveries_snapshot_id_unique" UNIQUE("snapshot_id")
);
--> statement-breakpoint
ALTER TABLE "integration_artifact_deliveries" ADD CONSTRAINT "integration_artifact_deliveries_snapshot_id_shared_threads_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."shared_threads"("id") ON DELETE cascade ON UPDATE no action;