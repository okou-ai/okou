-- Owner-approved 2026-10-09 tariff: default Auto is Haiku 5.5-priced,
-- including Luna fallback. Official 5-minute cache write rates; >100K input
-- tokens uses Haiku's long-context tier. $1 = 1000 credits.
-- https://www.anthropic.com/claude-haiku-5-5
-- DSF uses the OpenRouter DeepSeek official endpoint's standard (peak) tariff,
-- not dynamic/off-peak discounts. Cache creation is uncached input, not a
-- separate cache-write premium; long context has the same tariff.
-- https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints
-- https://api-docs.deepseek.com/quick_start/pricing/
-- Keep all legacy prices, historical usage and captured execution metadata.
-- Accept an operator's matching pre-seed, but never silently replace a different
-- live tariff. The migration runner owns the transaction and rollback.
DO $$
DECLARE
  price record;
BEGIN
  FOR price IN
    SELECT * FROM (VALUES
      ('@preset/okou-1-0', 'tokens.input', 100),
      ('@preset/okou-1-0', 'tokens.output', 500),
      ('@preset/okou-1-0', 'tokens.cache_read', 10),
      ('@preset/okou-1-0', 'tokens.cache_creation', 125),
      ('@preset/okou-1-0', 'tokens.input.long_context', 500),
      ('@preset/okou-1-0', 'tokens.output.long_context', 2500),
      ('@preset/okou-1-0', 'tokens.cache_read.long_context', 50),
      ('@preset/okou-1-0', 'tokens.cache_creation.long_context', 625),
      ('@preset/okou-1-0-dsf', 'tokens.input', 300),
      ('@preset/okou-1-0-dsf', 'tokens.output', 1200),
      ('@preset/okou-1-0-dsf', 'tokens.cache_read', 6),
      ('@preset/okou-1-0-dsf', 'tokens.cache_creation', 300),
      ('@preset/okou-1-0-dsf', 'tokens.input.long_context', 300),
      ('@preset/okou-1-0-dsf', 'tokens.output.long_context', 1200),
      ('@preset/okou-1-0-dsf', 'tokens.cache_read.long_context', 6),
      ('@preset/okou-1-0-dsf', 'tokens.cache_creation.long_context', 300)
    ) AS prices(provider, category, unit_price)
  LOOP
    INSERT INTO usage_pricing (kind, provider, category, unit_price, unit_size)
    VALUES ('model', price.provider, price.category, price.unit_price, 1000000)
    ON CONFLICT (kind, provider, category) DO NOTHING;

    IF NOT EXISTS (
      SELECT 1 FROM usage_pricing
      WHERE kind = 'model'
        AND provider = price.provider
        AND category = price.category
        AND unit_price = price.unit_price
        AND unit_size = 1000000
    ) THEN
      RAISE EXCEPTION 'Canonical Auto pricing conflicts with existing tariff: % %',
        price.provider, price.category;
    END IF;
  END LOOP;
END $$;
