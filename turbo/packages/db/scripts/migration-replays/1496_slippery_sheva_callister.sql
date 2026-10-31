-- okou:non-transactional
-- Preserve shipped 1496 and its journal identity; widen both columns atomically.
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "custom_connector_account_oauth_bindings" ALTER COLUMN "client_id" SET DATA TYPE text;
  ALTER TABLE "org_custom_connector_dcr_registrations" ALTER COLUMN "client_id" SET DATA TYPE text;
END
$$;
--> statement-breakpoint
RESET lock_timeout;
--> statement-breakpoint
RESET statement_timeout;
