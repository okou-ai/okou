CREATE TABLE "browser_chat_sessions" (
	"chat_thread_id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" varchar(64) DEFAULT 'browser' NOT NULL,
	"instance_id" uuid,
	"state" varchar(16),
	"primary_window_id" bigint,
	"expires_at" timestamp,
	"encrypted_tab_urls" text,
	"tab_urls_captured_at" timestamp,
	"screenshot_object_key" text,
	"screenshot_url" text,
	"screenshot_captured_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"live_browser_status" varchar(16) GENERATED ALWAYS AS (CASE WHEN state = 'active' THEN 'active' END) STORED,
	CONSTRAINT "uq_browser_chat_sessions_native_window" UNIQUE("instance_id","primary_window_id"),
	CONSTRAINT "browser_chat_sessions_binding_check" CHECK (
    ("browser_chat_sessions"."instance_id" IS NULL AND "browser_chat_sessions"."state" IS NULL AND "browser_chat_sessions"."primary_window_id" IS NULL AND "browser_chat_sessions"."expires_at" IS NULL)
    OR ("browser_chat_sessions"."instance_id" IS NOT NULL AND "browser_chat_sessions"."state" IS NOT NULL AND "browser_chat_sessions"."state" IN ('active', 'closing')
      AND "browser_chat_sessions"."primary_window_id" IS NOT NULL AND "browser_chat_sessions"."expires_at" IS NOT NULL)),
	CONSTRAINT "browser_chat_sessions_primary_check" CHECK ("browser_chat_sessions"."primary_window_id" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "browser_chat_sessions_deadline_check" CHECK ("browser_chat_sessions"."expires_at" > "browser_chat_sessions"."created_at"),
	CONSTRAINT "browser_chat_sessions_urls_check" CHECK (("browser_chat_sessions"."encrypted_tab_urls" IS NULL) = ("browser_chat_sessions"."tab_urls_captured_at" IS NULL)),
	CONSTRAINT "browser_chat_sessions_screenshot_check" CHECK (
    ("browser_chat_sessions"."screenshot_object_key" IS NULL AND "browser_chat_sessions"."screenshot_url" IS NULL AND "browser_chat_sessions"."screenshot_captured_at" IS NULL)
    OR ("browser_chat_sessions"."screenshot_object_key" IS NOT NULL AND "browser_chat_sessions"."screenshot_url" IS NOT NULL AND "browser_chat_sessions"."screenshot_captured_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "browser_chat_sessions" ADD CONSTRAINT "browser_chat_sessions_owner_fk" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."browser_owner_profiles"("org_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_chat_sessions" ADD CONSTRAINT "browser_chat_sessions_instance_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."browser_owner_profiles"("instance_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_chat_sessions" ADD CONSTRAINT "browser_chat_sessions_active_instance_fk" FOREIGN KEY ("instance_id","live_browser_status") REFERENCES "public"."browser_owner_profiles"("instance_id","status") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_browser_chat_sessions_owner" ON "browser_chat_sessions" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_browser_chat_sessions_reconcile" ON "browser_chat_sessions" USING btree ("updated_at");