-- Global model catalog foundation. Additive: no existing reader changes.
-- run_model_catalog gains the catalog columns; model_routes is new. Existing
-- allow_new_org_policy values of recognized models are preserved; newly
-- inserted rows default to false, matching today's fail-closed treatment of a
-- missing row.
--
-- Replacement chains may have several hops. The self foreign key
-- (replaced_by, replaced_by_lineage_rank) -> (model, lineage_rank) rejects
-- dangling targets, and replaced_by_lineage_rank > lineage_rank makes every
-- hop strictly increase the rank, so self-references and cycles are
-- impossible without triggers.
ALTER TABLE "run_model_catalog" ADD COLUMN "display_name" varchar(128);--> statement-breakpoint
ALTER TABLE "run_model_catalog" ADD COLUMN "sort_order" integer;--> statement-breakpoint
ALTER TABLE "run_model_catalog" ADD COLUMN "is_system_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "run_model_catalog" ADD COLUMN "replaced_by" varchar(255);--> statement-breakpoint
ALTER TABLE "run_model_catalog" ADD COLUMN "lineage_rank" integer;--> statement-breakpoint
ALTER TABLE "run_model_catalog" ADD COLUMN "replaced_by_lineage_rank" integer;--> statement-breakpoint
CREATE TEMP TABLE "model_catalog_seed" (
  "model" varchar(255) PRIMARY KEY,
  "display_name" varchar(128) NOT NULL,
  "sort_order" integer NOT NULL,
  "is_system_default" boolean NOT NULL,
  "replaced_by" varchar(255),
  "lineage_rank" integer NOT NULL
) ON COMMIT DROP;--> statement-breakpoint
-- Every recognized model in SUPPORTED_RUN_MODELS order with its current label.
-- Retired models carry their owner-approved replacement: Fable 5 -> Fable 5.1,
-- Opus 4.8 -> Opus 5.5, Sonnet 4.6 -> Sonnet 5.5, DeepSeek V4 Pro -> GPT 6
-- Luna and GPT 5.5 -> GPT 6 Luna. Replacement only resolves the model; it never
-- carries credentials, provider routes or upstream IDs across providers.
-- Active rows start at lineage rank 100 and retired rows at 0, so every
-- approved hop increases the rank and later retirements have room on both
-- sides.
INSERT INTO "model_catalog_seed" ("model", "display_name", "sort_order", "is_system_default", "replaced_by", "lineage_rank") VALUES
  ('okou-1.0', 'Auto', 10, true, NULL, 100),
  ('claude-fable-5-1', 'Claude Fable 5.1', 20, false, NULL, 100),
  ('claude-fable-5', 'Claude Fable 5', 30, false, 'claude-fable-5-1', 0),
  ('claude-opus-5-5', 'Claude Opus 5.5', 40, false, NULL, 100),
  ('claude-opus-5', 'Claude Opus 5', 50, false, NULL, 100),
  ('claude-opus-4-8', 'Claude Opus 4.8', 60, false, 'claude-opus-5-5', 0),
  ('claude-sonnet-5-5', 'Claude Sonnet 5.5', 70, false, NULL, 100),
  ('claude-sonnet-5', 'Claude Sonnet 5', 80, false, NULL, 100),
  ('claude-sonnet-4-6', 'Claude Sonnet 4.6', 90, false, 'claude-sonnet-5-5', 0),
  ('gpt-6-astra', 'GPT 6 Astra', 100, false, NULL, 100),
  ('gpt-6.1-sol', 'GPT 6.1 Sol', 110, false, NULL, 100),
  ('gpt-6-sol', 'GPT 6 Sol', 120, false, NULL, 100),
  ('gpt-6-luna', 'GPT 6 Luna', 130, false, NULL, 100),
  ('gpt-5.6-sol', 'GPT 5.6 Sol', 140, false, NULL, 100),
  ('gpt-5.6-luna', 'GPT 5.6 Luna', 150, false, NULL, 100),
  ('gpt-5.5', 'GPT 5.5', 160, false, 'gpt-6-luna', 0),
  ('deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', 170, false, NULL, 100),
  ('deepseek-v4-pro', 'DeepSeek V4 Pro', 180, false, 'gpt-6-luna', 0),
  ('deepseek-v4-flash', 'DeepSeek V4 Flash', 190, false, NULL, 100);--> statement-breakpoint
INSERT INTO "run_model_catalog" ("model", "display_name", "sort_order", "is_system_default", "replaced_by", "lineage_rank", "replaced_by_lineage_rank")
SELECT "seed"."model", "seed"."display_name", "seed"."sort_order", "seed"."is_system_default", "seed"."replaced_by", "seed"."lineage_rank", "target"."lineage_rank"
FROM "model_catalog_seed" AS "seed"
LEFT JOIN "model_catalog_seed" AS "target" ON "target"."model" = "seed"."replaced_by"
ON CONFLICT ("model") DO UPDATE SET
  "display_name" = EXCLUDED."display_name",
  "sort_order" = EXCLUDED."sort_order",
  "is_system_default" = EXCLUDED."is_system_default",
  "replaced_by" = EXCLUDED."replaced_by",
  "lineage_rank" = EXCLUDED."lineage_rank",
  "replaced_by_lineage_rank" = EXCLUDED."replaced_by_lineage_rank",
  "updated_at" = now();--> statement-breakpoint
-- Rows outside the seed are IDs the code does not recognize (production may
-- hold gpt-5.6-terra, okou-1.0-pro or okou-1.0-max). They are kept, not
-- deleted: no replacement has been approved for them. They get their ID as
-- label, sort after every recognized model, stay without routes (so nothing
-- can execute them) and are made explicitly non-addable through
-- allow_new_org_policy. Retiring or activating them is an owner decision
-- recorded in MIGRATIONS.md.
UPDATE "run_model_catalog" AS "catalog"
SET
  "display_name" = left("catalog"."model", 128),
  "sort_order" = 1000 + "ordered"."position",
  "lineage_rank" = 100,
  "allow_new_org_policy" = false,
  "updated_at" = now()
FROM (
  SELECT "model", row_number() OVER (ORDER BY "model")::integer AS "position"
  FROM "run_model_catalog"
  WHERE "model" NOT IN (SELECT "model" FROM "model_catalog_seed")
) AS "ordered"
WHERE "ordered"."model" = "catalog"."model";--> statement-breakpoint
ALTER TABLE "run_model_catalog" ALTER COLUMN "display_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "run_model_catalog" ALTER COLUMN "sort_order" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "run_model_catalog" ALTER COLUMN "lineage_rank" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "run_model_catalog" ADD CONSTRAINT "uq_run_model_catalog_model_lineage_rank" UNIQUE("model","lineage_rank");--> statement-breakpoint
ALTER TABLE "run_model_catalog" ADD CONSTRAINT "fk_run_model_catalog_replaced_by" FOREIGN KEY ("replaced_by","replaced_by_lineage_rank") REFERENCES "public"."run_model_catalog"("model","lineage_rank") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "run_model_catalog" ADD CONSTRAINT "chk_run_model_catalog_replacement_pair" CHECK (("run_model_catalog"."replaced_by" IS NULL) = ("run_model_catalog"."replaced_by_lineage_rank" IS NULL));--> statement-breakpoint
ALTER TABLE "run_model_catalog" ADD CONSTRAINT "chk_run_model_catalog_not_self_replaced" CHECK ("run_model_catalog"."replaced_by" <> "run_model_catalog"."model");--> statement-breakpoint
ALTER TABLE "run_model_catalog" ADD CONSTRAINT "chk_run_model_catalog_replacement_rank" CHECK ("run_model_catalog"."replaced_by_lineage_rank" > "run_model_catalog"."lineage_rank");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_run_model_catalog_one_system_default" ON "run_model_catalog" USING btree ("is_system_default") WHERE "run_model_catalog"."is_system_default";--> statement-breakpoint
ALTER TABLE "run_model_catalog" ADD CONSTRAINT "chk_run_model_catalog_default_active" CHECK (NOT "run_model_catalog"."is_system_default" OR "run_model_catalog"."replaced_by" IS NULL);--> statement-breakpoint
CREATE TABLE "model_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model" varchar(255) NOT NULL,
	"provider_type" varchar(64) NOT NULL,
	"concrete_provider_type" varchar(64) NOT NULL,
	"subscription_type" varchar(40),
	"upstream_model" varchar(255) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"service_tiers" text[] NOT NULL,
	"default_service_tier" varchar(20),
	"efforts" text[] NOT NULL,
	"default_effort" varchar(20),
	"price_tier" varchar(8),
	"pricing_kind" varchar(30),
	"pricing_provider" varchar(100),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_model_routes_identity" UNIQUE NULLS NOT DISTINCT("model","provider_type","subscription_type","concrete_provider_type"),
	CONSTRAINT "uq_model_routes_priority" UNIQUE NULLS NOT DISTINCT("model","provider_type","subscription_type","priority"),
	CONSTRAINT "chk_model_routes_provider_type" CHECK ("model_routes"."provider_type" IN ('claude-code-oauth-token', 'anthropic-api-key', 'openrouter-api-key', 'deepseek', 'vercel-ai-gateway', 'openrouter-codex', 'vercel-ai-gateway-codex', 'openai-api-key', 'codex-oauth-token', 'azure-foundry', 'aws-bedrock', 'custom-anthropic-messages', 'custom-openai-responses', 'built-in')),
	CONSTRAINT "chk_model_routes_concrete_provider_type" CHECK (CASE WHEN "model_routes"."provider_type" = 'built-in' THEN "model_routes"."concrete_provider_type" IN ('anthropic-api-key', 'openrouter-api-key', 'deepseek', 'openrouter-codex', 'openai-api-key') ELSE "model_routes"."concrete_provider_type" = "model_routes"."provider_type" END),
	CONSTRAINT "chk_model_routes_subscription_type" CHECK ("model_routes"."subscription_type" IS NULL OR ("model_routes"."subscription_type" IN ('claude-code-oauth-token', 'codex-oauth-token') AND "model_routes"."subscription_type" = "model_routes"."provider_type")),
	CONSTRAINT "chk_model_routes_priority" CHECK ("model_routes"."priority" >= 0),
	CONSTRAINT "chk_model_routes_service_tiers" CHECK ("model_routes"."service_tiers" <@ ARRAY['priority', 'ultrafast']::text[] AND ("model_routes"."default_service_tier" IS NULL OR "model_routes"."default_service_tier" = ANY("model_routes"."service_tiers"))),
	CONSTRAINT "chk_model_routes_efforts" CHECK ("model_routes"."efforts" <@ ARRAY['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'extra', 'ultracode']::text[] AND ("model_routes"."default_effort" IS NULL OR "model_routes"."default_effort" = ANY("model_routes"."efforts"))),
	CONSTRAINT "chk_model_routes_price_tier" CHECK ("model_routes"."price_tier" IS NULL OR ("model_routes"."provider_type" = 'built-in' AND "model_routes"."price_tier" IN ('$', '$$', '$$$', '$$$$'))),
	CONSTRAINT "chk_model_routes_pricing_link" CHECK (CASE WHEN "model_routes"."provider_type" = 'built-in' THEN "model_routes"."pricing_kind" = 'model' AND "model_routes"."pricing_provider" IS NOT NULL ELSE "model_routes"."pricing_kind" IS NULL AND "model_routes"."pricing_provider" IS NULL END)
);
--> statement-breakpoint
ALTER TABLE "model_routes" ADD CONSTRAINT "model_routes_model_run_model_catalog_model_fk" FOREIGN KEY ("model") REFERENCES "public"."run_model_catalog"("model") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Built-in candidates from BUILT_IN_MODEL_TO_PROVIDER, in fallback order. Each
-- links to the usage_pricing (kind='model', provider=<model>) rows that bill it.
INSERT INTO "model_routes" ("model", "provider_type", "concrete_provider_type", "subscription_type", "upstream_model", "priority", "service_tiers", "efforts", "default_effort", "price_tier", "pricing_kind", "pricing_provider") VALUES
  ('okou-1.0', 'built-in', 'openrouter-codex', NULL, '@preset/okou-1-0', 0, ARRAY[]::text[], ARRAY[]::text[], NULL, '$', 'model', 'okou-1.0'),
  ('claude-fable-5-1', 'built-in', 'anthropic-api-key', NULL, 'claude-fable-5-1', 0, ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'extra', 'max', 'ultracode'], 'max', '$$$$', 'model', 'claude-fable-5-1'),
  ('claude-fable-5-1', 'built-in', 'openrouter-api-key', NULL, 'anthropic/claude-fable-5.1', 1, ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'extra', 'max', 'ultracode'], 'max', '$$$$', 'model', 'claude-fable-5-1'),
  ('claude-opus-5-5', 'built-in', 'anthropic-api-key', NULL, 'claude-opus-5-5', 0, ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'extra', 'max', 'ultracode'], 'medium', '$$$', 'model', 'claude-opus-5-5'),
  ('claude-opus-5-5', 'built-in', 'openrouter-api-key', NULL, 'anthropic/claude-opus-5.5', 1, ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'extra', 'max', 'ultracode'], 'medium', '$$$', 'model', 'claude-opus-5-5'),
  ('claude-opus-5', 'built-in', 'anthropic-api-key', NULL, 'claude-opus-5', 0, ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'extra', 'max', 'ultracode'], 'high', '$$$', 'model', 'claude-opus-5'),
  ('claude-opus-5', 'built-in', 'openrouter-api-key', NULL, 'anthropic/claude-opus-5', 1, ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'extra', 'max', 'ultracode'], 'high', '$$$', 'model', 'claude-opus-5'),
  ('claude-sonnet-5-5', 'built-in', 'anthropic-api-key', NULL, 'claude-sonnet-5-5', 0, ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'extra', 'max', 'ultracode'], 'high', '$$', 'model', 'claude-sonnet-5-5'),
  ('claude-sonnet-5', 'built-in', 'anthropic-api-key', NULL, 'claude-sonnet-5', 0, ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'extra', 'max', 'ultracode'], 'high', '$$', 'model', 'claude-sonnet-5'),
  ('claude-sonnet-5', 'built-in', 'openrouter-api-key', NULL, 'anthropic/claude-sonnet-5', 1, ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'extra', 'max', 'ultracode'], 'high', '$$', 'model', 'claude-sonnet-5'),
  ('gpt-6-astra', 'built-in', 'openai-api-key', NULL, 'gpt-6-astra', 0, ARRAY['priority'], ARRAY['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'max', '$$$$', 'model', 'gpt-6-astra'),
  ('gpt-6-astra', 'built-in', 'openrouter-codex', NULL, 'openai/gpt-6-astra', 1, ARRAY['priority'], ARRAY['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'max', '$$$$', 'model', 'gpt-6-astra'),
  ('gpt-6.1-sol', 'built-in', 'openai-api-key', NULL, 'gpt-6.1-sol', 0, ARRAY['priority'], ARRAY['low', 'medium', 'high', 'xhigh', 'max'], 'medium', '$$$', 'model', 'gpt-6.1-sol'),
  ('gpt-6-sol', 'built-in', 'openai-api-key', NULL, 'gpt-6-sol', 0, ARRAY['priority'], ARRAY['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'max', '$$$', 'model', 'gpt-6-sol'),
  ('gpt-6-sol', 'built-in', 'openrouter-codex', NULL, 'openai/gpt-6-sol', 1, ARRAY['priority'], ARRAY['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'max', '$$$', 'model', 'gpt-6-sol'),
  ('gpt-6-luna', 'built-in', 'openai-api-key', NULL, 'gpt-6-luna', 0, ARRAY['priority'], ARRAY['low', 'medium', 'high', 'xhigh', 'max'], 'max', '$', 'model', 'gpt-6-luna'),
  ('gpt-6-luna', 'built-in', 'openrouter-codex', NULL, 'openai/gpt-6-luna', 1, ARRAY['priority'], ARRAY['low', 'medium', 'high', 'xhigh', 'max'], 'max', '$', 'model', 'gpt-6-luna'),
  ('gpt-5.6-sol', 'built-in', 'openai-api-key', NULL, 'gpt-5.6-sol', 0, ARRAY['priority'], ARRAY['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'max', '$$$', 'model', 'gpt-5.6-sol'),
  ('gpt-5.6-sol', 'built-in', 'openrouter-codex', NULL, 'openai/gpt-5.6-sol', 1, ARRAY['priority'], ARRAY['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'max', '$$$', 'model', 'gpt-5.6-sol'),
  ('gpt-5.6-luna', 'built-in', 'openai-api-key', NULL, 'gpt-5.6-luna', 0, ARRAY['priority'], ARRAY['low', 'medium', 'high', 'xhigh', 'max'], 'max', '$', 'model', 'gpt-5.6-luna'),
  ('gpt-5.6-luna', 'built-in', 'openrouter-codex', NULL, 'openai/gpt-5.6-luna', 1, ARRAY['priority'], ARRAY['low', 'medium', 'high', 'xhigh', 'max'], 'max', '$', 'model', 'gpt-5.6-luna'),
  ('deepseek-v4.1-flash', 'built-in', 'deepseek', NULL, 'deepseek-flash', 0, ARRAY[]::text[], ARRAY[]::text[], NULL, '$', 'model', 'deepseek-v4.1-flash'),
  ('deepseek-v4.1-flash', 'built-in', 'openrouter-codex', NULL, 'deepseek/deepseek-v4.1-flash', 1, ARRAY[]::text[], ARRAY[]::text[], NULL, '$', 'model', 'deepseek-v4.1-flash'),
  ('deepseek-v4-flash', 'built-in', 'deepseek', NULL, 'deepseek-v4-flash', 0, ARRAY[]::text[], ARRAY['low', 'high', 'xhigh', 'max'], 'high', '$', 'model', 'deepseek-v4-flash'),
  ('deepseek-v4-flash', 'built-in', 'openrouter-codex', NULL, 'deepseek/deepseek-v4-flash', 1, ARRAY[]::text[], ARRAY['low', 'high', 'xhigh', 'max'], 'high', '$', 'model', 'deepseek-v4-flash');--> statement-breakpoint
-- BYOK routes from the model-first provider compatibility and runtime aliases.
INSERT INTO "model_routes" ("model", "provider_type", "concrete_provider_type", "subscription_type", "upstream_model", "priority", "service_tiers", "efforts", "default_effort", "price_tier", "pricing_kind", "pricing_provider") VALUES
  ('claude-fable-5-1', 'claude-code-oauth-token', 'claude-code-oauth-token', NULL, 'claude-fable-5-1', 0, ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'extra', 'max', 'ultracode'], 'max', NULL, NULL, NULL),
  ('claude-fable-5-1', 'anthropic-api-key', 'anthropic-api-key', NULL, 'claude-fable-5-1', 0, ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'extra', 'max', 'ultracode'], 'max', NULL, NULL, NULL),
  ('claude-fable-5-1', 'openrouter-api-key', 'openrouter-api-key', NULL, 'anthropic/claude-fable-5.1', 0, ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'extra', 'max', 'ultracode'], 'max', NULL, NULL, NULL),
  ('claude-fable-5-1', 'vercel-ai-gateway', 'vercel-ai-gateway', NULL, 'anthropic/claude-fable-5.1', 0, ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'extra', 'max', 'ultracode'], 'max', NULL, NULL, NULL),
  ('claude-fable-5-1', 'azure-foundry', 'azure-foundry', NULL, 'claude-fable-5-1', 0, ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'extra', 'max', 'ultracode'], 'max', NULL, NULL, NULL),
  ('claude-fable-5-1', 'aws-bedrock', 'aws-bedrock', NULL, 'claude-fable-5-1', 0, ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'extra', 'max', 'ultracode'], 'max', NULL, NULL, NULL),
  ('claude-opus-5-5', 'claude-code-oauth-token', 'claude-code-oauth-token', NULL, 'claude-opus-5-5', 0, ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'extra', 'max', 'ultracode'], 'medium', NULL, NULL, NULL),
  ('claude-opus-5-5', 'anthropic-api-key', 'anthropic-api-key', NULL, 'claude-opus-5-5', 0, ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'extra', 'max', 'ultracode'], 'medium', NULL, NULL, NULL),
  ('claude-opus-5-5', 'openrouter-api-key', 'openrouter-api-key', NULL, 'anthropic/claude-opus-5.5', 0, ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'extra', 'max', 'ultracode'], 'medium', NULL, NULL, NULL),
  ('claude-opus-5-5', 'vercel-ai-gateway', 'vercel-ai-gateway', NULL, 'anthropic/claude-opus-5.5', 0, ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'extra', 'max', 'ultracode'], 'medium', NULL, NULL, NULL),
  ('claude-opus-5-5', 'azure-foundry', 'azure-foundry', NULL, 'claude-opus-5-5', 0, ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'extra', 'max', 'ultracode'], 'medium', NULL, NULL, NULL),
  ('claude-opus-5-5', 'aws-bedrock', 'aws-bedrock', NULL, 'claude-opus-5-5', 0, ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'extra', 'max', 'ultracode'], 'medium', NULL, NULL, NULL),
  ('claude-opus-5', 'claude-code-oauth-token', 'claude-code-oauth-token', NULL, 'claude-opus-5', 0, ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'extra', 'max', 'ultracode'], 'high', NULL, NULL, NULL),
  ('claude-opus-5', 'anthropic-api-key', 'anthropic-api-key', NULL, 'claude-opus-5', 0, ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'extra', 'max', 'ultracode'], 'high', NULL, NULL, NULL),
  ('claude-opus-5', 'openrouter-api-key', 'openrouter-api-key', NULL, 'anthropic/claude-opus-5', 0, ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'extra', 'max', 'ultracode'], 'high', NULL, NULL, NULL),
  ('claude-opus-5', 'vercel-ai-gateway', 'vercel-ai-gateway', NULL, 'anthropic/claude-opus-5', 0, ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'extra', 'max', 'ultracode'], 'high', NULL, NULL, NULL),
  ('claude-opus-5', 'azure-foundry', 'azure-foundry', NULL, 'claude-opus-5', 0, ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'extra', 'max', 'ultracode'], 'high', NULL, NULL, NULL),
  ('claude-opus-5', 'aws-bedrock', 'aws-bedrock', NULL, 'claude-opus-5', 0, ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'extra', 'max', 'ultracode'], 'high', NULL, NULL, NULL),
  ('claude-sonnet-5-5', 'anthropic-api-key', 'anthropic-api-key', NULL, 'claude-sonnet-5-5', 0, ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'extra', 'max', 'ultracode'], 'high', NULL, NULL, NULL),
  ('claude-sonnet-5-5', 'claude-code-oauth-token', 'claude-code-oauth-token', NULL, 'claude-sonnet-5-5', 0, ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'extra', 'max', 'ultracode'], 'high', NULL, NULL, NULL),
  ('claude-sonnet-5', 'claude-code-oauth-token', 'claude-code-oauth-token', NULL, 'claude-sonnet-5', 0, ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'extra', 'max', 'ultracode'], 'high', NULL, NULL, NULL),
  ('claude-sonnet-5', 'anthropic-api-key', 'anthropic-api-key', NULL, 'claude-sonnet-5', 0, ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'extra', 'max', 'ultracode'], 'high', NULL, NULL, NULL),
  ('claude-sonnet-5', 'openrouter-api-key', 'openrouter-api-key', NULL, 'anthropic/claude-sonnet-5', 0, ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'extra', 'max', 'ultracode'], 'high', NULL, NULL, NULL),
  ('claude-sonnet-5', 'vercel-ai-gateway', 'vercel-ai-gateway', NULL, 'anthropic/claude-sonnet-5', 0, ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'extra', 'max', 'ultracode'], 'high', NULL, NULL, NULL),
  ('claude-sonnet-5', 'azure-foundry', 'azure-foundry', NULL, 'claude-sonnet-5', 0, ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'extra', 'max', 'ultracode'], 'high', NULL, NULL, NULL),
  ('claude-sonnet-5', 'aws-bedrock', 'aws-bedrock', NULL, 'claude-sonnet-5', 0, ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'extra', 'max', 'ultracode'], 'high', NULL, NULL, NULL),
  ('gpt-6-astra', 'openai-api-key', 'openai-api-key', NULL, 'gpt-6-astra', 0, ARRAY['priority', 'ultrafast'], ARRAY['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'max', NULL, NULL, NULL),
  ('gpt-6-astra', 'codex-oauth-token', 'codex-oauth-token', NULL, 'gpt-6-astra', 0, ARRAY['priority'], ARRAY['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'max', NULL, NULL, NULL),
  ('gpt-6-astra', 'openrouter-codex', 'openrouter-codex', NULL, 'openai/gpt-6-astra', 0, ARRAY['priority'], ARRAY['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'max', NULL, NULL, NULL),
  ('gpt-6.1-sol', 'openai-api-key', 'openai-api-key', NULL, 'gpt-6.1-sol', 0, ARRAY['priority'], ARRAY['low', 'medium', 'high', 'xhigh', 'max'], 'medium', NULL, NULL, NULL),
  ('gpt-6.1-sol', 'codex-oauth-token', 'codex-oauth-token', NULL, 'gpt-6.1-sol', 0, ARRAY['priority'], ARRAY['low', 'medium', 'high', 'xhigh', 'max'], 'medium', NULL, NULL, NULL),
  ('gpt-6-sol', 'openai-api-key', 'openai-api-key', NULL, 'gpt-6-sol', 0, ARRAY['priority'], ARRAY['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'max', NULL, NULL, NULL),
  ('gpt-6-sol', 'codex-oauth-token', 'codex-oauth-token', NULL, 'gpt-6-sol', 0, ARRAY['priority'], ARRAY['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'max', NULL, NULL, NULL),
  ('gpt-6-sol', 'openrouter-codex', 'openrouter-codex', NULL, 'openai/gpt-6-sol', 0, ARRAY['priority'], ARRAY['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'max', NULL, NULL, NULL),
  ('gpt-6-luna', 'openai-api-key', 'openai-api-key', NULL, 'gpt-6-luna', 0, ARRAY['priority'], ARRAY['low', 'medium', 'high', 'xhigh', 'max'], 'max', NULL, NULL, NULL),
  ('gpt-6-luna', 'codex-oauth-token', 'codex-oauth-token', NULL, 'gpt-6-luna', 0, ARRAY['priority'], ARRAY['low', 'medium', 'high', 'xhigh', 'max'], 'max', NULL, NULL, NULL),
  ('gpt-6-luna', 'openrouter-codex', 'openrouter-codex', NULL, 'openai/gpt-6-luna', 0, ARRAY['priority'], ARRAY['low', 'medium', 'high', 'xhigh', 'max'], 'max', NULL, NULL, NULL),
  ('gpt-5.6-sol', 'openai-api-key', 'openai-api-key', NULL, 'gpt-5.6-sol', 0, ARRAY['priority'], ARRAY['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'max', NULL, NULL, NULL),
  ('gpt-5.6-sol', 'codex-oauth-token', 'codex-oauth-token', NULL, 'gpt-5.6-sol', 0, ARRAY['priority'], ARRAY['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'max', NULL, NULL, NULL),
  ('gpt-5.6-sol', 'openrouter-codex', 'openrouter-codex', NULL, 'openai/gpt-5.6-sol', 0, ARRAY['priority'], ARRAY['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'max', NULL, NULL, NULL),
  ('gpt-5.6-sol', 'vercel-ai-gateway-codex', 'vercel-ai-gateway-codex', NULL, 'openai/gpt-5.6-sol', 0, ARRAY['priority'], ARRAY['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'max', NULL, NULL, NULL),
  ('gpt-5.6-luna', 'openai-api-key', 'openai-api-key', NULL, 'gpt-5.6-luna', 0, ARRAY['priority'], ARRAY['low', 'medium', 'high', 'xhigh', 'max'], 'max', NULL, NULL, NULL),
  ('gpt-5.6-luna', 'codex-oauth-token', 'codex-oauth-token', NULL, 'gpt-5.6-luna', 0, ARRAY['priority'], ARRAY['low', 'medium', 'high', 'xhigh', 'max'], 'max', NULL, NULL, NULL),
  ('gpt-5.6-luna', 'openrouter-codex', 'openrouter-codex', NULL, 'openai/gpt-5.6-luna', 0, ARRAY['priority'], ARRAY['low', 'medium', 'high', 'xhigh', 'max'], 'max', NULL, NULL, NULL),
  ('gpt-5.6-luna', 'vercel-ai-gateway-codex', 'vercel-ai-gateway-codex', NULL, 'openai/gpt-5.6-luna', 0, ARRAY['priority'], ARRAY['low', 'medium', 'high', 'xhigh', 'max'], 'max', NULL, NULL, NULL),
  ('deepseek-v4.1-flash', 'openrouter-codex', 'openrouter-codex', NULL, 'deepseek/deepseek-v4.1-flash', 0, ARRAY[]::text[], ARRAY[]::text[], NULL, NULL, NULL, NULL),
  ('deepseek-v4-flash', 'deepseek', 'deepseek', NULL, 'deepseek-v4-flash', 0, ARRAY[]::text[], ARRAY['low', 'high', 'xhigh', 'max'], 'high', NULL, NULL, NULL),
  ('deepseek-v4-flash', 'openrouter-codex', 'openrouter-codex', NULL, 'deepseek/deepseek-v4-flash', 0, ARRAY[]::text[], ARRAY['low', 'high', 'xhigh', 'max'], 'high', NULL, NULL, NULL);--> statement-breakpoint
-- Auto-mode personal subscription routes copied from the live catalog.
DO $$
DECLARE
  unknown_models text;
BEGIN
  SELECT string_agg(DISTINCT "subscription"."model", ', ') INTO unknown_models
  FROM "subscription_model_catalog" AS "subscription"
  LEFT JOIN "model_catalog_seed" AS "seed"
    ON "seed"."model" = "subscription"."model" AND "seed"."replaced_by" IS NULL
  WHERE "seed"."model" IS NULL;
  IF unknown_models IS NOT NULL THEN
    RAISE EXCEPTION 'subscription_model_catalog lists models outside the active catalog: %', unknown_models;
  END IF;
END
$$;--> statement-breakpoint
INSERT INTO "model_routes" ("model", "provider_type", "concrete_provider_type", "subscription_type", "upstream_model", "priority", "service_tiers", "efforts", "default_effort")
SELECT
  "model",
  "subscription_type",
  "subscription_type",
  "subscription_type",
  "model",
  0,
  CASE WHEN "service_tier" IS NULL THEN ARRAY[]::text[] ELSE ARRAY["service_tier"]::text[] END,
  "efforts",
  NULL
FROM "subscription_model_catalog";
