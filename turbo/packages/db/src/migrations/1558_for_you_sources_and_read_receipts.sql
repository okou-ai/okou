CREATE TABLE "feed_preferences" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"suggestions" boolean DEFAULT true NOT NULL,
	"whats_new" boolean DEFAULT true NOT NULL,
	"offers" boolean DEFAULT true NOT NULL,
	CONSTRAINT "feed_preferences_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "feed_items" ADD COLUMN "read_at" timestamp with time zone;