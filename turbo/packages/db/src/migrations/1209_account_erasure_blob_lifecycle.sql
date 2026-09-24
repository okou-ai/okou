CREATE TABLE "blob_upload_intents" (
	"hash" varchar(64) NOT NULL,
	"intent_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "blob_upload_intents_hash_intent_id_pk" PRIMARY KEY("hash","intent_id")
);
--> statement-breakpoint
ALTER TABLE "blobs" ADD COLUMN "erasure_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "blobs" ADD COLUMN "erasure_eligible_at" timestamp with time zone DEFAULT now() + interval '49 hours' NOT NULL;--> statement-breakpoint
ALTER TABLE "blob_upload_intents" ADD CONSTRAINT "blob_upload_intents_hash_blobs_hash_fk" FOREIGN KEY ("hash") REFERENCES "public"."blobs"("hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blob_upload_intents_expires_at" ON "blob_upload_intents" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "blobs" ADD CONSTRAINT "blobs_erasure_pending_zero_refs" CHECK (NOT "blobs"."erasure_pending" OR "blobs"."ref_count" = 0);