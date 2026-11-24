CREATE TABLE "hosted_site_domain_settings" (
	"site_id" uuid PRIMARY KEY NOT NULL,
	"selected_domain_id" uuid,
	"revision" uuid DEFAULT gen_random_uuid() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hosted_site_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"hostname" text NOT NULL,
	"revision" uuid DEFAULT gen_random_uuid() NOT NULL,
	"challenge" text NOT NULL,
	"challenge_expires_at" timestamp with time zone NOT NULL,
	"provider_id" text,
	"provider_started" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"verification" jsonb,
	"verifying_id" uuid,
	"verifying_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hosted_site_domains_site_id_id" UNIQUE("site_id","id")
);
--> statement-breakpoint
ALTER TABLE "hosted_site_domain_settings" ADD CONSTRAINT "hosted_site_domain_settings_site_id_hosted_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."hosted_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosted_site_domain_settings" ADD CONSTRAINT "hosted_site_domain_settings_site_id_selected_domain_id_hosted_site_domains_site_id_id_fk" FOREIGN KEY ("site_id","selected_domain_id") REFERENCES "public"."hosted_site_domains"("site_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosted_site_domains" ADD CONSTRAINT "hosted_site_domains_site_id_hosted_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."hosted_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_hosted_site_domains_site" ON "hosted_site_domains" USING btree ("site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hosted_site_domains_site_hostname" ON "hosted_site_domains" USING btree ("site_id","hostname") WHERE "hosted_site_domains"."released_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "hosted_site_domains_verified_hostname" ON "hosted_site_domains" USING btree ("hostname") WHERE "hosted_site_domains"."verified_at" IS NOT NULL AND "hosted_site_domains"."released_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "hosted_site_domains_provider_id" ON "hosted_site_domains" USING btree ("provider_id");