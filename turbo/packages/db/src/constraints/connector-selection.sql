-- Drizzle does not model PostgreSQL foreign-key deferral. These are part of
-- the current schema contract, not application triggers or coordination state.
ALTER TABLE "chat_thread_connector_selections" ALTER CONSTRAINT "fk_chat_thread_connector_selections_connector_slug" DEFERRABLE INITIALLY IMMEDIATE;
--> statement-breakpoint
ALTER TABLE "chat_thread_connector_selections" ALTER CONSTRAINT "fk_chat_thread_connector_selections_custom_connector" DEFERRABLE INITIALLY IMMEDIATE;
