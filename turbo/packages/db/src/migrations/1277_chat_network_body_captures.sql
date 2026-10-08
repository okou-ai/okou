CREATE TABLE "chat_network_body_captures" (
	"chat_event_id" uuid PRIMARY KEY NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_network_body_captures" ADD CONSTRAINT "chat_network_body_captures_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_network_body_captures_chat_thread_idx" ON "chat_network_body_captures" USING btree ("chat_thread_id");