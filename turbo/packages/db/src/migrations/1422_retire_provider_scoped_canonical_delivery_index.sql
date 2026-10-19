-- okou:non-transactional
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '10min';
--> statement-breakpoint
-- The released API and retained rollback writers use (asset_id, operation_id).
-- Preserve that arbiter before retiring the redundant provider-scoped index.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index
    WHERE indexrelid = to_regclass('public.canonical_asset_deliveries_asset_operation_unique')
      AND indrelid = 'public.canonical_asset_deliveries'::regclass
      AND indisunique AND indisvalid AND indisready
  ) THEN
    RAISE EXCEPTION 'Canonical delivery operation index must be valid before retiring the provider-scoped index';
  END IF;
END $$;
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "public"."canonical_asset_deliveries_asset_provider_operation_unique";
--> statement-breakpoint
RESET statement_timeout;
--> statement-breakpoint
RESET lock_timeout;
