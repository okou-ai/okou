CREATE TABLE "hosted_site_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"email" text NOT NULL,
	"user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "hosted_site_shares_site_email" UNIQUE("site_id","email")
);
--> statement-breakpoint
ALTER TABLE "hosted_site_shares" ADD CONSTRAINT "hosted_site_shares_site_id_hosted_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."hosted_sites"("id") ON DELETE cascade ON UPDATE no action;