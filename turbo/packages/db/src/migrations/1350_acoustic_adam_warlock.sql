CREATE TABLE "mail_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"source_run_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"outbox_id" uuid,
	"status" text NOT NULL,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mail_notifications_owner_key_unique" ON "mail_notifications" USING btree ("org_id","user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_notifications_outbox_unique" ON "mail_notifications" USING btree ("outbox_id");--> statement-breakpoint
CREATE INDEX "mail_notifications_user_idx" ON "mail_notifications" USING btree ("user_id");