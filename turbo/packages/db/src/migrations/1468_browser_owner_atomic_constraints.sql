-- okou:non-transactional
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.browser_owner_profiles'::regclass
      AND conname = 'uq_browser_owner_profiles_owner'
  ) THEN
    ALTER TABLE "browser_owner_profiles" ADD CONSTRAINT "uq_browser_owner_profiles_owner"
      UNIQUE USING INDEX "uq_browser_owner_profiles_owner";
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.browser_owner_profiles'::regclass
      AND conname = 'uq_browser_owner_profiles_provider'
  ) THEN
    ALTER TABLE "browser_owner_profiles" ADD CONSTRAINT "uq_browser_owner_profiles_provider"
      UNIQUE USING INDEX "uq_browser_owner_profiles_provider";
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.browser_owner_profiles'::regclass
      AND conname = 'uq_browser_owner_profiles_session'
  ) THEN
    ALTER TABLE "browser_owner_profiles" ADD CONSTRAINT "uq_browser_owner_profiles_session"
      UNIQUE USING INDEX "uq_browser_owner_profiles_session";
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.browser_owner_windows'::regclass
      AND conname = 'uq_browser_owner_windows_native_window'
  ) THEN
    ALTER TABLE "browser_owner_windows" ADD CONSTRAINT "uq_browser_owner_windows_native_window"
      UNIQUE USING INDEX "uq_browser_owner_windows_native_window";
  END IF;
END $$;
--> statement-breakpoint
RESET lock_timeout;
--> statement-breakpoint
RESET statement_timeout;
