CREATE TABLE "discord_user_identities" (
	"discord_user_id" varchar(255) PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "uq_discord_user_identity_owner" UNIQUE("discord_user_id","user_id")
);
--> statement-breakpoint
-- Preserve verified owners; ambiguous cross-account senders fail closed rather than choosing an owner.
INSERT INTO "discord_user_identities" ("discord_user_id", "user_id")
SELECT DISTINCT "discord_user_id", "user_id" FROM "discord_org_connections";
--> statement-breakpoint
ALTER TABLE "discord_org_connections" ADD CONSTRAINT "fk_discord_connection_identity_owner" FOREIGN KEY ("discord_user_id","user_id") REFERENCES "public"."discord_user_identities"("discord_user_id","user_id") ON DELETE cascade ON UPDATE no action;