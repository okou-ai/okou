-- Keep the final queue check and drop in the same transaction.
LOCK TABLE "public"."pi_resource_version_indexes" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "public"."pi_resource_version_indexes"
    WHERE status NOT IN ('ready', 'unindexable')
       OR lease_id IS NOT NULL
       OR lease_expires_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Cannot retire the Pi resource index while work is unfinished or leased';
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE "public"."pi_resource_version_indexes" RESTRICT;
