ALTER TABLE "hosted_sites" ADD COLUMN "show_banner" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "hosted_sites" ADD COLUMN "banner_revision" uuid;