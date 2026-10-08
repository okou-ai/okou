ALTER TABLE "discord_org_connections" DROP CONSTRAINT "fk_discord_connection_identity_owner";
--> statement-breakpoint
ALTER TABLE "discord_org_connections" ADD CONSTRAINT "fk_discord_connection_identity_owner" FOREIGN KEY ("discord_user_id","user_id") REFERENCES "public"."discord_user_identities"("discord_user_id","user_id") ON DELETE restrict ON UPDATE no action;