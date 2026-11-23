CREATE TABLE "hosted_site_share_rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"window_started_at" timestamp NOT NULL,
	"requests" integer NOT NULL
);
