ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_chat_thread_id_chat_threads_id_fk";
--> statement-breakpoint
ALTER TABLE "workflow_user_automation_threads" DROP CONSTRAINT "workflow_user_automation_threads_chat_thread_id_chat_threads_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_event_search_message_watermarks" ADD CONSTRAINT "chat_event_search_message_watermarks_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_event_search_messages" ADD CONSTRAINT "chat_event_search_messages_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_user_automation_threads" ADD CONSTRAINT "workflow_user_automation_threads_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE no action ON UPDATE no action;