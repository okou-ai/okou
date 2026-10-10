CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "discord_org_connections" ADD CONSTRAINT "ex_discord_connections_global_sender_owner"
  EXCLUDE USING gist ("discord_user_id" WITH =, "user_id" WITH <>);
