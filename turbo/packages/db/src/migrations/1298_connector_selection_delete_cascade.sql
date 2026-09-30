ALTER TABLE "chat_thread_connector_selections" DROP CONSTRAINT "fk_chat_thread_connector_selections_connector_slug";
--> statement-breakpoint
ALTER TABLE "chat_thread_connector_selections" DROP CONSTRAINT "fk_chat_thread_connector_selections_custom_connector";
--> statement-breakpoint
ALTER TABLE "chat_thread_connector_selections" ADD CONSTRAINT "fk_chat_thread_connector_selections_connector_slug" FOREIGN KEY ("connector_id","connector_slug") REFERENCES "public"."connectors"("id","connector_slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_thread_connector_selections" ADD CONSTRAINT "fk_chat_thread_connector_selections_custom_connector" FOREIGN KEY ("connector_id","custom_connector_id") REFERENCES "public"."connectors"("id","custom_connector_id") ON DELETE cascade ON UPDATE no action;