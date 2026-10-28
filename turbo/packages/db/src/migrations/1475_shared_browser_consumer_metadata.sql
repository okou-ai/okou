ALTER TABLE "browser_owner_profiles" ADD COLUMN "proxy_country_code" varchar(2);--> statement-breakpoint
ALTER TABLE "browser_owner_windows" ADD COLUMN "screen_height" integer DEFAULT 900 NOT NULL;