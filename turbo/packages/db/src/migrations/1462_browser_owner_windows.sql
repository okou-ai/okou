CREATE TABLE "browser_owner_profiles" (
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
	CONSTRAINT "uq_browser_owner_profiles_instance" UNIQUE("instance_id"),
	CONSTRAINT "uq_browser_owner_profiles_instance_state" UNIQUE("instance_id","status"),
	CONSTRAINT "browser_owner_profiles_status_check" CHECK ("browser_owner_profiles"."status" IN ('creating', 'active', 'stopping', 'stopped')),
	CONSTRAINT "browser_owner_profiles_provider_check" CHECK (("browser_owner_profiles"."status" <> 'active' OR "browser_owner_profiles"."provider_session_id" IS NOT NULL)
          AND ("browser_owner_profiles"."status" <> 'creating' OR "browser_owner_profiles"."provider_session_id" IS NULL)),
	CONSTRAINT "browser_owner_profiles_deadline_check" CHECK ("browser_owner_profiles"."creation_expires_at" > "browser_owner_profiles"."created_at"
          AND "browser_owner_profiles"."timeout_at" >= "browser_owner_profiles"."creation_expires_at")
);
--> statement-breakpoint
CREATE TABLE "browser_owner_windows" (
	"chat_thread_id" uuid PRIMARY KEY NOT NULL,
	"instance_id" uuid NOT NULL,
	"state" varchar(16) NOT NULL,
	"primary_window_id" bigint NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"live_browser_status" varchar(16) GENERATED ALWAYS AS (CASE WHEN state = 'active' THEN 'active' END) STORED,
	CONSTRAINT "browser_owner_windows_state_check" CHECK ("browser_owner_windows"."state" IN ('active', 'closing')),
	CONSTRAINT "browser_owner_windows_primary_check" CHECK ("browser_owner_windows"."primary_window_id" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "browser_owner_windows_deadline_check" CHECK ("browser_owner_windows"."expires_at" > "browser_owner_windows"."created_at")
);
--> statement-breakpoint
ALTER TABLE "browser_owner_windows" ADD CONSTRAINT "browser_owner_windows_instance_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."browser_owner_profiles"("instance_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_owner_windows" ADD CONSTRAINT "browser_owner_windows_active_instance_fk" FOREIGN KEY ("instance_id","live_browser_status") REFERENCES "public"."browser_owner_profiles"("instance_id","status") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_browser_owner_profiles_owner" ON "browser_owner_profiles" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_browser_owner_profiles_provider" ON "browser_owner_profiles" USING btree ("provider_profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_browser_owner_profiles_session" ON "browser_owner_profiles" USING btree ("provider_session_id");--> statement-breakpoint
CREATE INDEX "idx_browser_owner_profiles_reconcile" ON "browser_owner_profiles" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_browser_owner_windows_native_window" ON "browser_owner_windows" USING btree ("instance_id","primary_window_id");--> statement-breakpoint
CREATE INDEX "idx_browser_owner_windows_expiry" ON "browser_owner_windows" USING btree ("state","expires_at");