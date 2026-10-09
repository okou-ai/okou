ALTER TABLE "discord_org_connections" ALTER COLUMN "oauth_grant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "discord_org_installations" ALTER COLUMN "org_grant_id" SET NOT NULL;