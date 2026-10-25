CREATE TABLE "browser_owner_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_profile_id" uuid NOT NULL,
	"provider_session_id" uuid,
	"status" varchar(16) NOT NULL,
	"windows" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"creation_expires_at" timestamp NOT NULL,
	"timeout_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "browser_owner_instances_status_check" CHECK ("browser_owner_instances"."status" IN ('creating', 'active', 'stopping', 'stopped')),
	CONSTRAINT "browser_owner_instances_provider_check" CHECK (("browser_owner_instances"."status" <> 'active' OR "browser_owner_instances"."provider_session_id" IS NOT NULL)
        AND ("browser_owner_instances"."status" <> 'creating' OR "browser_owner_instances"."provider_session_id" IS NULL)),
	CONSTRAINT "browser_owner_instances_windows_check" CHECK (jsonb_typeof("browser_owner_instances"."windows") = 'object'),
	CONSTRAINT "browser_owner_instances_deadline_check" CHECK ("browser_owner_instances"."creation_expires_at" > "browser_owner_instances"."created_at"
        AND "browser_owner_instances"."timeout_at" >= "browser_owner_instances"."creation_expires_at")
);
--> statement-breakpoint
CREATE TABLE "browser_owner_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider_profile_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "browser_user_action_requests" ADD COLUMN "window_session_id" uuid;--> statement-breakpoint
ALTER TABLE "browser_owner_instances" ADD CONSTRAINT "browser_owner_instances_owner_profile_id_browser_owner_profiles_id_fk" FOREIGN KEY ("owner_profile_id") REFERENCES "public"."browser_owner_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_browser_owner_instances_live_owner" ON "browser_owner_instances" USING btree ("owner_profile_id") WHERE "browser_owner_instances"."status" IN ('creating', 'active', 'stopping');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_browser_owner_instances_provider" ON "browser_owner_instances" USING btree ("provider_session_id");--> statement-breakpoint
CREATE INDEX "idx_browser_owner_instances_reconcile" ON "browser_owner_instances" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_browser_owner_profiles_owner" ON "browser_owner_profiles" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_browser_owner_profiles_provider" ON "browser_owner_profiles" USING btree ("provider_profile_id");