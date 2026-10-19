CREATE TABLE "agentphone_contact_card_deliveries" (
	"user_link_id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"conversation_id" text,
	"attempt_message_id" text,
	"attempted_at" timestamp,
	"provider_message_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agentphone_contact_card_status" CHECK ("agentphone_contact_card_deliveries"."status" IN ('pending', 'unknown', 'sent', 'failed')),
	CONSTRAINT "agentphone_contact_card_attempt" CHECK ("agentphone_contact_card_deliveries"."status" = 'pending' OR ("agentphone_contact_card_deliveries"."conversation_id" IS NOT NULL AND "agentphone_contact_card_deliveries"."attempt_message_id" IS NOT NULL AND "agentphone_contact_card_deliveries"."attempted_at" IS NOT NULL)),
	CONSTRAINT "agentphone_contact_card_receipt" CHECK (("agentphone_contact_card_deliveries"."status" = 'sent') = ("agentphone_contact_card_deliveries"."provider_message_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "agentphone_contact_card_deliveries" ADD CONSTRAINT "agentphone_contact_card_user_link_fk" FOREIGN KEY ("user_link_id") REFERENCES "public"."agentphone_user_links"("id") ON DELETE cascade ON UPDATE no action;