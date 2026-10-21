ALTER TABLE "social_data_jobs" ADD COLUMN "source_job_id" uuid;--> statement-breakpoint
ALTER TABLE "social_data_jobs" ADD COLUMN "provider_cursor" jsonb;--> statement-breakpoint
ALTER TABLE "social_data_jobs" ADD COLUMN "next_provider_cursor" jsonb;--> statement-breakpoint
ALTER TABLE "social_data_jobs" ADD COLUMN "collection_progress" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_social_data_jobs_source" ON "social_data_jobs" USING btree ("source_job_id");--> statement-breakpoint
-- Managed data requests settle actual provider USD micros at the same 25% markup as SEO.
INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size") VALUES
  ('social', 'monid/douyin', 'provider_cost_usd_micros', 1250, 1000000),
  ('social', 'monid/weibo', 'provider_cost_usd_micros', 1250, 1000000),
  ('commerce', 'dataforseo', 'provider_cost_usd_micros', 1250, 1000000)
ON CONFLICT ("kind", "provider", "category") DO NOTHING;