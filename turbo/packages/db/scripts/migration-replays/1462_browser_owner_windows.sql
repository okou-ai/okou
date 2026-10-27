-- okou:non-transactional
-- Canonical execution of shipped 1462; its original SQL and journal identity remain immutable.
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "browser_owner_profiles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" text NOT NULL,
  "user_id" text NOT NULL,
  "provider_profile_id" uuid NOT NULL,
  "instance_id" uuid NOT NULL,
  "provider_session_id" uuid,
  "status" varchar(16) NOT NULL,
  "creation_expires_at" timestamp NOT NULL,
  "timeout_at" timestamp NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uq_browser_owner_profiles_owner" UNIQUE ("org_id", "user_id"),
  CONSTRAINT "uq_browser_owner_profiles_provider" UNIQUE ("provider_profile_id"),
  CONSTRAINT "uq_browser_owner_profiles_instance" UNIQUE ("instance_id"),
  CONSTRAINT "uq_browser_owner_profiles_session" UNIQUE ("provider_session_id"),
  CONSTRAINT "uq_browser_owner_profiles_instance_state" UNIQUE ("instance_id", "status"),
  CONSTRAINT "browser_owner_profiles_status_check" CHECK ("status" IN ('creating', 'active', 'stopping', 'stopped')),
  CONSTRAINT "browser_owner_profiles_provider_check" CHECK (
    ("status" <> 'active' OR "provider_session_id" IS NOT NULL)
    AND ("status" <> 'creating' OR "provider_session_id" IS NULL)
  ),
  CONSTRAINT "browser_owner_profiles_deadline_check" CHECK (
    "creation_expires_at" > "created_at"
    AND "timeout_at" >= "creation_expires_at"
  )
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "browser_owner_windows" (
  "chat_thread_id" uuid PRIMARY KEY NOT NULL,
  "instance_id" uuid NOT NULL,
  "state" varchar(16) NOT NULL,
  "primary_window_id" bigint NOT NULL,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "live_browser_status" varchar(16) GENERATED ALWAYS AS (CASE WHEN state = 'active' THEN 'active' END) STORED,
  CONSTRAINT "uq_browser_owner_windows_native_window" UNIQUE ("instance_id", "primary_window_id"),
  CONSTRAINT "browser_owner_windows_instance_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."browser_owner_profiles" ("instance_id") ON DELETE no action ON UPDATE no action,
  CONSTRAINT "browser_owner_windows_active_instance_fk" FOREIGN KEY ("instance_id", "live_browser_status") REFERENCES "public"."browser_owner_profiles" ("instance_id", "status") ON DELETE no action ON UPDATE no action,
  CONSTRAINT "browser_owner_windows_state_check" CHECK ("state" IN ('active', 'closing')),
  CONSTRAINT "browser_owner_windows_primary_check" CHECK ("primary_window_id" BETWEEN 0 AND 9007199254740991),
  CONSTRAINT "browser_owner_windows_deadline_check" CHECK ("expires_at" > "created_at")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_browser_owner_profiles_reconcile" ON "browser_owner_profiles" USING btree ("status", "updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_browser_owner_windows_expiry" ON "browser_owner_windows" USING btree ("state", "expires_at");
--> statement-breakpoint
RESET lock_timeout;
--> statement-breakpoint
RESET statement_timeout;
