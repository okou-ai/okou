CREATE TABLE "chat_thread_drafts" (
	"chat_thread_id" uuid NOT NULL,
	"draft_user_message" jsonb,
	"draft_attachments" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chat_thread_drafts_chat_thread_id_pk" PRIMARY KEY("chat_thread_id"),
	CONSTRAINT "chat_thread_drafts_draft_user_message_check" CHECK ("chat_thread_drafts"."draft_user_message" IS NOT NULL
          OR COALESCE("chat_thread_drafts"."draft_attachments", '[]'::jsonb) = '[]'::jsonb)
);
--> statement-breakpoint
ALTER TABLE "chat_thread_drafts" ADD CONSTRAINT "chat_thread_drafts_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;