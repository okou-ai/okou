INSERT INTO "run_model_catalog" ("model", "allow_new_org_policy")
VALUES
	('okou-1.0', true),
	('okou-1.0-pro', true),
	('okou-1.0-max', true)
ON CONFLICT ("model") DO NOTHING;
--> statement-breakpoint
-- Give each Okou model its own billing identity while copying the complete
-- corresponding GPT 5.6 price schedule from the development seed. The four
-- variants cover base, long-context, fast, and long-context fast usage.
WITH "base_prices" ("provider", "category", "unit_price") AS (
	VALUES
		('okou-1.0', 'tokens.input', 200),
		('okou-1.0', 'tokens.cache_read', 20),
		('okou-1.0', 'tokens.cache_creation', 250),
		('okou-1.0', 'tokens.output', 1200),
		('okou-1.0-pro', 'tokens.input', 5000),
		('okou-1.0-pro', 'tokens.cache_read', 500),
		('okou-1.0-pro', 'tokens.cache_creation', 6250),
		('okou-1.0-pro', 'tokens.output', 30000),
		('okou-1.0-max', 'tokens.input', 5000),
		('okou-1.0-max', 'tokens.cache_read', 500),
		('okou-1.0-max', 'tokens.cache_creation', 6250),
		('okou-1.0-max', 'tokens.output', 30000)
),
"price_variants" (
	"category_suffix",
	"input_family_multiplier",
	"output_multiplier"
) AS (
	VALUES
		('', 1::numeric, 1::numeric),
		('.long_context', 2::numeric, 1.5::numeric),
		('.fast', 2::numeric, 2::numeric),
		('.long_context.fast', 4::numeric, 3::numeric)
)
INSERT INTO "usage_pricing" (
	"kind",
	"provider",
	"category",
	"unit_price",
	"unit_size"
)
SELECT
	'model',
	"base_prices"."provider",
	"base_prices"."category" || "price_variants"."category_suffix",
	(
		"base_prices"."unit_price" * CASE
			WHEN "base_prices"."category" = 'tokens.output'
				THEN "price_variants"."output_multiplier"
			ELSE "price_variants"."input_family_multiplier"
		END
	)::bigint,
	1000000
FROM "base_prices"
CROSS JOIN "price_variants"
ON CONFLICT ("kind", "provider", "category") DO UPDATE SET
	"unit_price" = EXCLUDED."unit_price",
	"unit_size" = EXCLUDED."unit_size",
	"updated_at" = NOW();
