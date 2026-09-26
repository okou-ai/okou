ALTER TABLE "chat_threads" DROP CONSTRAINT "chat_threads_draft_user_message_check";--> statement-breakpoint
DROP INDEX "uq_chat_thread_drafts_thread_user";--> statement-breakpoint
ALTER TABLE "chat_thread_drafts" DROP CONSTRAINT "chat_thread_drafts_chat_thread_id_pk";--> statement-breakpoint
ALTER TABLE "chat_thread_drafts" ADD CONSTRAINT "chat_thread_drafts_chat_thread_id_user_id_pk" PRIMARY KEY("chat_thread_id","user_id");--> statement-breakpoint
ALTER TABLE "chat_threads" DROP COLUMN "draft_user_message";--> statement-breakpoint
ALTER TABLE "chat_threads" DROP COLUMN "draft_attachments";