ALTER TABLE "mail_drafts" ADD COLUMN "provider" text DEFAULT 'gmail' NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_drafts" ADD COLUMN "outlook_message_id" text;--> statement-breakpoint
ALTER TABLE "mail_drafts" ADD COLUMN "outlook_conversation_id" text;--> statement-breakpoint
ALTER TABLE "mail_drafts" ADD COLUMN "outlook_web_link" text;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_drafts_connector_outlook_message_unique" ON "mail_drafts" USING btree ("connector_id","outlook_message_id");