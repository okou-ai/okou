CREATE TABLE "queued_chat_threads" (
	"chat_thread_id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"queued_at" timestamp NOT NULL,
	"claim_id" uuid,
	"claim_expires_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "queued_chat_threads" ADD CONSTRAINT "queued_chat_threads_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "queued_chat_threads_org_queued_at_idx" ON "queued_chat_threads" USING btree ("org_id","queued_at");