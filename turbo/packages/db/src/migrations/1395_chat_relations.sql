CREATE TABLE "chat_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"source_chat_thread_id" uuid NOT NULL,
	"target_chat_thread_id" uuid NOT NULL,
	"source_run_id" uuid NOT NULL,
	"target_run_id" uuid,
	"message_event_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chat_relations_different_threads" CHECK ("chat_relations"."source_chat_thread_id" <> "chat_relations"."target_chat_thread_id"),
	CONSTRAINT "chat_relations_shape" CHECK (("chat_relations"."type" = 'created' AND "chat_relations"."message_event_id" IS NULL AND "chat_relations"."target_run_id" IS NULL) OR ("chat_relations"."type" = 'message' AND "chat_relations"."message_event_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_relations_created_target_unique" ON "chat_relations" USING btree ("target_chat_thread_id") WHERE "chat_relations"."type" = 'created';--> statement-breakpoint
CREATE UNIQUE INDEX "chat_relations_message_event_unique" ON "chat_relations" USING btree ("message_event_id") WHERE "chat_relations"."type" = 'message';--> statement-breakpoint
CREATE INDEX "chat_relations_source_idx" ON "chat_relations" USING btree ("org_id","user_id","source_chat_thread_id","type","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "chat_relations_target_idx" ON "chat_relations" USING btree ("org_id","user_id","target_chat_thread_id","type","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);