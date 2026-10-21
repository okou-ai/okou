CREATE TABLE "hosted_site_browser_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"user_id" text NOT NULL,
	"clerk_session_id" text NOT NULL,
	"code_hash" text,
	"code_challenge" text,
	"token_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "hosted_site_browser_sessions_code_hash_unique" UNIQUE("code_hash"),
	CONSTRAINT "hosted_site_browser_sessions_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "hosted_site_browser_sessions_credential" CHECK (("hosted_site_browser_sessions"."code_hash" IS NOT NULL AND "hosted_site_browser_sessions"."code_challenge" IS NOT NULL AND "hosted_site_browser_sessions"."token_hash" IS NULL) OR ("hosted_site_browser_sessions"."code_hash" IS NULL AND "hosted_site_browser_sessions"."code_challenge" IS NULL AND "hosted_site_browser_sessions"."token_hash" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "hosted_site_browser_sessions" ADD CONSTRAINT "hosted_site_browser_sessions_site_id_hosted_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."hosted_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_hosted_site_browser_sessions_expiry" ON "hosted_site_browser_sessions" USING btree ("expires_at");