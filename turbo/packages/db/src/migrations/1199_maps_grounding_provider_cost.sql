-- Gemini 2.5 Flash Maps searches record the combined model-token and grounded-
-- prompt list cost in micro-USD. 1,250 credits per USD applies the requested
-- 25% managed-service markup exactly once before whole-credit settlement.
-- Existing Maps rows remain for historical usage and rolling deploy safety.
-- https://cloud.google.com/vertex-ai/generative-ai/pricing
INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
VALUES ('maps', 'google-maps-grounding', 'provider_cost_usd_micros', 1250, 1000000)
ON CONFLICT ("kind", "provider", "category") DO NOTHING;
