CREATE TABLE "wechat_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sequence" bigserial NOT NULL,
	"connection_id" uuid NOT NULL,
	"generation" uuid NOT NULL,
	"provider_message_id" text,
	"direction" text NOT NULL,
	"status" text NOT NULL,
	"content" text NOT NULL,
	"quoted_text" text,
	"request_hash" text,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"media_ciphertext" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "wechat_messages_delivery_check" CHECK (("wechat_messages"."direction" = 'inbound' AND "wechat_messages"."status" = 'received') OR ("wechat_messages"."direction" = 'outbound' AND "wechat_messages"."status" IN ('sent', 'unknown')))
);
--> statement-breakpoint
ALTER TABLE "wechat_messages" ADD CONSTRAINT "wechat_messages_connection_id_wechat_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."wechat_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wechat_messages_connection_sequence_idx" ON "wechat_messages" USING btree ("connection_id","sequence");