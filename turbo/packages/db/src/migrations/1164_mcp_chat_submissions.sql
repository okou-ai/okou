CREATE TABLE "mcp_chat_submissions" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"input_seq_id" bigint NOT NULL,
	"accepted_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_chat_submissions" ADD CONSTRAINT "mcp_chat_submissions_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_chat_submissions_thread_idx" ON "mcp_chat_submissions" USING btree ("thread_id");