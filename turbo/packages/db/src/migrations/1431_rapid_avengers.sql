CREATE TABLE "hosted_site_visibility" (
	"site_id" uuid PRIMARY KEY NOT NULL,
	"visibility" text NOT NULL,
	"revision" uuid NOT NULL,
	CONSTRAINT "hosted_site_visibility_audience" CHECK ("hosted_site_visibility"."visibility" IN ('private', 'organization', 'public'))
);
--> statement-breakpoint
ALTER TABLE "hosted_site_visibility" ADD CONSTRAINT "hosted_site_visibility_site_id_hosted_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."hosted_sites"("id") ON DELETE cascade ON UPDATE no action;