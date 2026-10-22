-- Preserve APIDojo pricing for historical usage and outgoing API versions.
-- Monid Yahoo Finance costs $0.05 per call; settle actual provider USD micros
-- at the same 25% markup as other managed Monid data tools.
INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size") VALUES
  ('finance', 'monid/yahoo-finance', 'provider_cost_usd_micros', 1250, 1000000)
ON CONFLICT ("kind", "provider", "category") DO NOTHING;
