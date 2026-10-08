-- Owner-approved removal of team-only Allowance history. Do not reprice usage
-- or convert discarded rights into credits. Drain old API/cron writers first.
ALTER TABLE "usage_event_hourly_rollup" DROP CONSTRAINT "fk_usage_event_hourly_rollup_short_window";--> statement-breakpoint
ALTER TABLE "usage_event_hourly_rollup" DROP CONSTRAINT "fk_usage_event_hourly_rollup_weekly_window";--> statement-breakpoint
ALTER TABLE "usage_event_hourly_rollup" DROP CONSTRAINT "chk_usage_event_hourly_rollup_allowance_units";--> statement-breakpoint
ALTER TABLE "usage_event_hourly_rollup" DROP CONSTRAINT "chk_usage_event_hourly_rollup_allowance_window_pair";--> statement-breakpoint
DROP INDEX "idx_usage_event_hourly_rollup_short_window_id";--> statement-breakpoint
DROP INDEX "idx_usage_event_hourly_rollup_weekly_window_id";--> statement-breakpoint
DROP INDEX "idx_usage_event_hourly_rollup_physical_grain";--> statement-breakpoint
ALTER TABLE "usage_event_hourly_rollup" DROP COLUMN "short_window_id";--> statement-breakpoint
ALTER TABLE "usage_event_hourly_rollup" DROP COLUMN "weekly_window_id";--> statement-breakpoint
ALTER TABLE "usage_event_hourly_rollup" DROP COLUMN "allowance_units";--> statement-breakpoint
CREATE INDEX "idx_usage_event_hourly_rollup_physical_grain" ON "usage_event_hourly_rollup" USING btree ("processed_hour" DESC NULLS LAST,"org_id","user_id","run_id","kind","provider","category");--> statement-breakpoint
DROP TABLE "usage_allowance_allocations";--> statement-breakpoint
DROP TABLE "org_usage_allowance_windows";--> statement-breakpoint
DROP TABLE "org_usage_allowance_entitlements";
