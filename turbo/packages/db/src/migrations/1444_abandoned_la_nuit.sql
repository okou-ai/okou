CREATE TABLE "openai_image_webhook_receipts" (
	"event_id" text PRIMARY KEY NOT NULL,
	"response_id" text NOT NULL,
	"event_type" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp
);
--> statement-breakpoint
CREATE INDEX "idx_openai_image_webhook_receipts_response_id" ON "openai_image_webhook_receipts" USING btree ("response_id");--> statement-breakpoint
CREATE INDEX "idx_openai_image_webhook_receipts_processed_at" ON "openai_image_webhook_receipts" USING btree ("processed_at","updated_at");
--> statement-breakpoint
-- GPT-4.1 orchestration rates: https://developers.openai.com/api/docs/models/gpt-4.1
-- Existing configured tariffs remain authoritative.
INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
VALUES
  ('model', 'openai/gpt-4.1', 'tokens.input', 2000, 1000000),
  ('model', 'openai/gpt-4.1', 'tokens.cache_read', 500, 1000000),
  ('model', 'openai/gpt-4.1', 'tokens.output', 8000, 1000000)
ON CONFLICT ("kind", "provider", "category") DO NOTHING;