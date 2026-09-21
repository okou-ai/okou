INSERT INTO "run_model_catalog" ("model", "allow_new_org_policy")
VALUES
	('okou-1.0', true),
	('okou-1.0-pro', true),
	('okou-1.0-max', true)
ON CONFLICT ("model") DO NOTHING;
--> statement-breakpoint
-- Give each Okou model its own billing identity while copying the complete
-- GPT 5.6 price schedule already configured in the target database. This keeps
-- the new identities aligned with the current managed rates at migration time.
WITH "price_sources" ("provider", "source_provider") AS (
	VALUES
		('okou-1.0', 'gpt-5.6-luna'),
		('okou-1.0-pro', 'gpt-5.6-sol'),
		('okou-1.0-max', 'gpt-5.6-sol')
)
INSERT INTO "usage_pricing" (
	"kind",
	"provider",
	"category",
	"unit_price",
	"unit_size"
)
SELECT
	"source_prices"."kind",
	"price_sources"."provider",
	"source_prices"."category",
	"source_prices"."unit_price",
	"source_prices"."unit_size"
FROM "price_sources"
INNER JOIN "usage_pricing" AS "source_prices"
	ON "source_prices"."kind" = 'model'
	AND "source_prices"."provider" = "price_sources"."source_provider"
ON CONFLICT ("kind", "provider", "category") DO UPDATE SET
	"unit_price" = EXCLUDED."unit_price",
	"unit_size" = EXCLUDED."unit_size",
	"updated_at" = NOW();
