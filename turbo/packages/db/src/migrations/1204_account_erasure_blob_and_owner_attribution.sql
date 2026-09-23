CREATE TABLE "blob_upload_intents" (
	"hash" varchar(64) NOT NULL,
	"intent_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "blob_upload_intents_hash_intent_id_pk" PRIMARY KEY("hash","intent_id")
);
--> statement-breakpoint
ALTER TABLE "blobs" ADD COLUMN "erasure_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "blobs" ADD COLUMN "erasure_eligible_at" timestamp with time zone DEFAULT now() + interval '49 hours' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "feishu_chat_ingress" ADD COLUMN "sender_open_id" varchar(255);--> statement-breakpoint
ALTER TABLE "feishu_chat_ingress" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "blob_upload_intents" ADD CONSTRAINT "blob_upload_intents_hash_blobs_hash_fk" FOREIGN KEY ("hash") REFERENCES "public"."blobs"("hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blob_upload_intents_expires_at" ON "blob_upload_intents" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "email_outbox_owner_user_id_idx" ON "email_outbox" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "feishu_chat_ingress_owner_user_id_idx" ON "feishu_chat_ingress" USING btree ("owner_user_id");--> statement-breakpoint
ALTER TABLE "blobs" ADD CONSTRAINT "blobs_erasure_pending_zero_refs" CHECK (NOT "blobs"."erasure_pending" OR "blobs"."ref_count" = 0);