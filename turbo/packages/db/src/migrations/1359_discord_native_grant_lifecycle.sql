CREATE TABLE "discord_org_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"initiated_by_user_id" text,
	"requested_guild_id" text,
	"verified_guild_id" varchar(255),
	"verified_bot_user_id" varchar(255),
	"approved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	CONSTRAINT "uq_discord_org_grant_installation" UNIQUE("id","org_id","verified_guild_id","verified_bot_user_id","approved_at"),
	CONSTRAINT "uq_discord_org_grant_installer" UNIQUE("id","initiated_by_user_id"),
	CONSTRAINT "chk_discord_org_grant_evidence" CHECK (("discord_org_grants"."verified_guild_id" IS NULL) = ("discord_org_grants"."verified_bot_user_id" IS NULL)),
	CONSTRAINT "chk_discord_org_grant_approval" CHECK ("discord_org_grants"."approved_at" IS NULL OR ("discord_org_grants"."verified_guild_id" IS NOT NULL AND "discord_org_grants"."verified_bot_user_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "discord_org_connections" DROP CONSTRAINT "fk_discord_connection_identity_owner";--> statement-breakpoint
ALTER TABLE "discord_user_identities" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "discord_user_identities";
--> statement-breakpoint
ALTER TABLE "discord_oauth_states" ALTER COLUMN "completion_token_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "discord_org_connections" ADD COLUMN "oauth_grant_id" uuid;--> statement-breakpoint
ALTER TABLE "discord_org_installations" ADD COLUMN "org_grant_id" uuid;--> statement-breakpoint
CREATE INDEX "idx_discord_org_grants_org" ON "discord_org_grants" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_discord_org_grants_initiator" ON "discord_org_grants" USING btree ("initiated_by_user_id");--> statement-breakpoint
CREATE INDEX "idx_discord_org_grants_expiry" ON "discord_org_grants" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "discord_oauth_states" ADD CONSTRAINT "uq_discord_oauth_grant_owner" UNIQUE("id","user_id","verified_discord_user_id","verified_guild_id");--> statement-breakpoint
ALTER TABLE "discord_org_connections" ADD CONSTRAINT "fk_discord_connection_oauth_grant" FOREIGN KEY ("oauth_grant_id","user_id","discord_user_id","guild_id") REFERENCES "public"."discord_oauth_states"("id","user_id","verified_discord_user_id","verified_guild_id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "discord_org_connections" VALIDATE CONSTRAINT "fk_discord_connection_oauth_grant";--> statement-breakpoint
ALTER TABLE "discord_org_installations" ADD CONSTRAINT "fk_discord_installation_org_grant" FOREIGN KEY ("org_grant_id","org_id","guild_id","bot_user_id","created_at") REFERENCES "public"."discord_org_grants"("id","org_id","verified_guild_id","verified_bot_user_id","approved_at") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "discord_org_installations" VALIDATE CONSTRAINT "fk_discord_installation_org_grant";--> statement-breakpoint
ALTER TABLE "discord_org_installations" ADD CONSTRAINT "fk_discord_installation_grant_installer" FOREIGN KEY ("org_grant_id","installed_by_user_id") REFERENCES "public"."discord_org_grants"("id","initiated_by_user_id") ON DELETE cascade ON UPDATE cascade NOT VALID;--> statement-breakpoint
ALTER TABLE "discord_org_installations" VALIDATE CONSTRAINT "fk_discord_installation_grant_installer";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "discord_org_connections" ADD CONSTRAINT "ex_discord_connections_global_sender_owner"
  EXCLUDE USING gist ("discord_user_id" WITH =, "user_id" WITH <>);
