-- Remove Okou markups from the current Auto presets and supported image models.
-- 1 USD = 1000 credits. Keep provider long-context/cache premiums, existing
-- image billing categories, and whole-credit settlement. Fractional rates use
-- unit_size rather than rounding the tariff (Ideogram Turbo: 15 / 2 credits/MP).
--
-- Auto reference tariffs:
-- https://www.anthropic.com/claude-haiku-5-5 (default; 5x above 100K input)
-- https://platform.claude.com/docs/en/about-claude/pricing (Opus 5.5)
-- https://api-docs.deepseek.com/quick_start/pricing (DSF standard peak rates)
-- Presets retain fixed benchmark tariffs, including when a fallback is used.
--
-- Image reference tariffs:
-- https://developers.openai.com/api/docs/pricing (GPT Image 2.5)
-- https://fal.ai/models (the existing per-image, tier and megapixel tariffs)
-- GPT Image 1/2 retain their existing standard/large quality-tier definitions.
-- No settled usage, balances or invoices are rewritten.
-- Update configured rows only; development and API-test baselines seed their
-- own synthetic Auto tariffs independently.
UPDATE "usage_pricing" AS pricing
SET "unit_price" = standard.unit_price,
    "unit_size" = standard.unit_size,
    "updated_at" = now()
FROM (VALUES
  ('image', 'alibaba/qwen-image-3/text-to-image', 'output_image.1k', 40, 1),
  ('image', 'alibaba/qwen-image-3/text-to-image', 'output_image.2k', 75, 1),
  ('image', 'fal-ai/bytedance/seedream/v4/text-to-image', 'output_image', 30, 1),
  ('image', 'fal-ai/flux-2-pro', 'processed_megapixel.additional', 15, 1),
  ('image', 'fal-ai/flux-2-pro', 'processed_megapixel.first', 30, 1),
  ('image', 'fal-ai/flux-pro/v1.1', 'output_megapixel', 40, 1),
  ('image', 'fal-ai/flux-pro/v1.1-ultra', 'output_image', 60, 1),
  ('image', 'fal-ai/nano-banana-2', 'output_image', 80, 1),
  ('image', 'google/nano-banana-2-lite', 'output_image', 42, 1),
  ('image', 'gpt-image-1', 'output_image.high.large', 250, 1),
  ('image', 'gpt-image-1', 'output_image.high.standard', 167, 1),
  ('image', 'gpt-image-1', 'output_image.low.large', 16, 1),
  ('image', 'gpt-image-1', 'output_image.low.standard', 11, 1),
  ('image', 'gpt-image-1', 'output_image.medium.large', 63, 1),
  ('image', 'gpt-image-1', 'output_image.medium.standard', 42, 1),
  ('image', 'gpt-image-2', 'output_image.high.large', 401, 1),
  ('image', 'gpt-image-2', 'output_image.high.standard', 211, 1),
  ('image', 'gpt-image-2', 'output_image.low.large', 12, 1),
  ('image', 'gpt-image-2', 'output_image.low.standard', 6, 1),
  ('image', 'gpt-image-2', 'output_image.medium.large', 101, 1),
  ('image', 'gpt-image-2', 'output_image.medium.standard', 53, 1),
  ('image', 'gpt-image-2.5-flare', 'tokens.input.image', 8000, 1000000),
  ('image', 'gpt-image-2.5-flare', 'tokens.input.text', 5000, 1000000),
  ('image', 'gpt-image-2.5-flare', 'tokens.output.image', 30000, 1000000),
  ('image', 'gpt-image-2.5-sunburst', 'tokens.input.image', 8000, 1000000),
  ('image', 'gpt-image-2.5-sunburst', 'tokens.input.text', 5000, 1000000),
  ('image', 'gpt-image-2.5-sunburst', 'tokens.output.image', 30000, 1000000),
  ('image', 'ideogram/v4', 'output_megapixel.balanced', 15, 1),
  ('image', 'ideogram/v4', 'output_megapixel.quality', 25, 1),
  ('image', 'ideogram/v4', 'output_megapixel.turbo', 15, 2),
  ('model', '@preset/okou-1-0', 'tokens.cache_creation', 125, 1000000),
  ('model', '@preset/okou-1-0', 'tokens.cache_creation.long_context', 625, 1000000),
  ('model', '@preset/okou-1-0', 'tokens.cache_read', 10, 1000000),
  ('model', '@preset/okou-1-0', 'tokens.cache_read.long_context', 50, 1000000),
  ('model', '@preset/okou-1-0', 'tokens.input', 100, 1000000),
  ('model', '@preset/okou-1-0', 'tokens.input.long_context', 500, 1000000),
  ('model', '@preset/okou-1-0', 'tokens.output', 500, 1000000),
  ('model', '@preset/okou-1-0', 'tokens.output.long_context', 2500, 1000000),
  ('model', '@preset/okou-1-0-dsf', 'tokens.cache_creation', 0, 1000000),
  ('model', '@preset/okou-1-0-dsf', 'tokens.cache_creation.long_context', 0, 1000000),
  ('model', '@preset/okou-1-0-dsf', 'tokens.cache_read', 6, 1000000),
  ('model', '@preset/okou-1-0-dsf', 'tokens.cache_read.long_context', 6, 1000000),
  ('model', '@preset/okou-1-0-dsf', 'tokens.input', 300, 1000000),
  ('model', '@preset/okou-1-0-dsf', 'tokens.input.long_context', 300, 1000000),
  ('model', '@preset/okou-1-0-dsf', 'tokens.output', 1200, 1000000),
  ('model', '@preset/okou-1-0-dsf', 'tokens.output.long_context', 1200, 1000000),
  ('model', '@preset/okou-opus', 'tokens.cache_creation', 5000, 1000000),
  ('model', '@preset/okou-opus', 'tokens.cache_creation.long_context', 5000, 1000000),
  ('model', '@preset/okou-opus', 'tokens.cache_read', 200, 1000000),
  ('model', '@preset/okou-opus', 'tokens.cache_read.long_context', 200, 1000000),
  ('model', '@preset/okou-opus', 'tokens.input', 4000, 1000000),
  ('model', '@preset/okou-opus', 'tokens.input.long_context', 4000, 1000000),
  ('model', '@preset/okou-opus', 'tokens.output', 20000, 1000000),
  ('model', '@preset/okou-opus', 'tokens.output.long_context', 20000, 1000000)
) AS standard(kind, provider, category, unit_price, unit_size)
WHERE pricing.kind = standard.kind
  AND pricing.provider = standard.provider
  AND pricing.category = standard.category
  AND (pricing.unit_price, pricing.unit_size)
    IS DISTINCT FROM (standard.unit_price, standard.unit_size);
