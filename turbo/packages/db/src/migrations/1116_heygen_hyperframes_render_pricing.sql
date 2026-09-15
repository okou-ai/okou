-- Published 1080p / 30 fps HyperFrames list price: $0.05 per output minute.
-- $0.05 * 1000 Okou credits/USD * 1.25 managed-service markup / 60 seconds.
-- This seeds list pricing, not a claim about a negotiated platform-account rate.
-- https://developers.heygen.com/docs/enterprise-pricing
INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
VALUES ('video', 'heygen-hyperframes-render', 'output_video_seconds', 125, 120)
ON CONFLICT ("kind", "provider", "category") DO NOTHING;
