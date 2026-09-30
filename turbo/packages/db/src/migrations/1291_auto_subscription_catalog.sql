CREATE TABLE "subscription_model_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_type" varchar(40) NOT NULL,
	"model" varchar(255) NOT NULL,
	"display_name" varchar(128) NOT NULL,
	"efforts" text[] NOT NULL,
	"service_tier" varchar(20),
	"sort_order" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_subscription_model_catalog_type" CHECK ("subscription_model_catalog"."subscription_type" IN ('claude-code-oauth-token', 'codex-oauth-token')),
	CONSTRAINT "chk_subscription_model_catalog_service_tier" CHECK ("subscription_model_catalog"."service_tier" IS NULL OR "subscription_model_catalog"."service_tier" = 'priority')
);
--> statement-breakpoint
ALTER TABLE "org_metadata" ADD COLUMN "model_mode" varchar(6) DEFAULT 'custom' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_subscription_model_catalog_type_model" ON "subscription_model_catalog" USING btree ("subscription_type","model");--> statement-breakpoint
ALTER TABLE "org_metadata" ADD CONSTRAINT "chk_org_metadata_model_mode" CHECK ("org_metadata"."model_mode" IN ('auto', 'custom'));--> statement-breakpoint
INSERT INTO "subscription_model_catalog" ("subscription_type", "model", "display_name", "efforts", "service_tier", "sort_order") VALUES
  ('claude-code-oauth-token', 'claude-sonnet-5-5', 'Claude Sonnet 5.5', ARRAY['low','medium','high','extra','max','ultracode'], NULL, 1),
  ('claude-code-oauth-token', 'claude-opus-5-5', 'Claude Opus 5.5', ARRAY['low','medium','high','extra','max','ultracode'], NULL, 2),
  ('claude-code-oauth-token', 'claude-fable-5-1', 'Claude Fable 5.1', ARRAY['low','medium','high','extra','max','ultracode'], NULL, 3),
  ('codex-oauth-token', 'gpt-6-luna', 'GPT 6 Luna', ARRAY['low','medium','high','xhigh','max'], 'priority', 1),
  ('codex-oauth-token', 'gpt-6.1-sol', 'GPT 6.1 Sol', ARRAY['low','medium','high','xhigh','max'], 'priority', 2),
  ('codex-oauth-token', 'gpt-6-sol', 'GPT 6 Sol', ARRAY['low','medium','high','xhigh','max','ultra'], 'priority', 3),
  ('codex-oauth-token', 'gpt-6-astra', 'GPT 6 Astra', ARRAY['low','medium','high','xhigh','max','ultra'], 'priority', 4);