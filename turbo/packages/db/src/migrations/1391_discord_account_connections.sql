ALTER TABLE "discord_org_connections" DROP CONSTRAINT "discord_org_connections_guild_id_discord_org_installations_guild_id_fk";
--> statement-breakpoint
ALTER TABLE "discord_org_connections" ALTER COLUMN "guild_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "discord_org_connections" ADD COLUMN "org_id" text;
--> statement-breakpoint
ALTER TABLE "discord_oauth_states" ADD CONSTRAINT "uq_discord_oauth_account_owner" UNIQUE("id","user_id","verified_discord_user_id","org_id");
--> statement-breakpoint
ALTER TABLE "discord_org_connections" ADD CONSTRAINT "fk_discord_connection_account_grant" FOREIGN KEY ("oauth_grant_id","user_id","discord_user_id","org_id") REFERENCES "public"."discord_oauth_states"("id","user_id","verified_discord_user_id","org_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
UPDATE "discord_org_connections" AS "connection"
SET "org_id" = "grant"."org_id"
FROM "discord_oauth_states" AS "grant"
WHERE "connection"."oauth_grant_id" = "grant"."id";
--> statement-breakpoint
ALTER TABLE "discord_org_connections" ADD CONSTRAINT "uq_discord_connections_org_sender" UNIQUE("org_id","discord_user_id");
--> statement-breakpoint
ALTER TABLE "discord_org_connections" ADD CONSTRAINT "uq_discord_connections_org_user" UNIQUE("org_id","user_id");
