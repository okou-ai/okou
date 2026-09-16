ALTER TABLE "email_outbox" ADD COLUMN "provider_idempotency_key" text;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "provider_request" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "email_outbox_provider_idempotency_key_unique" ON "email_outbox" USING btree ("provider_idempotency_key");