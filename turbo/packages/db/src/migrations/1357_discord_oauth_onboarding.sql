CREATE TYPE "public"."discord_oauth_failure" AS ENUM('cancelled', 'unavailable', 'forbidden', 'provider_error', 'invalid_authorization', 'guild_unverified', 'bot_missing');--> statement-breakpoint
CREATE TYPE "public"."discord_oauth_flow" AS ENUM('install', 'connect');--> statement-breakpoint
CREATE TYPE "public"."discord_oauth_phase" AS ENUM('pending', 'processing', 'verified', 'approved', 'failed');--> statement-breakpoint
CREATE TABLE "discord_oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state_hash" text NOT NULL,
	"completion_token_hash" text NOT NULL,
	"approval_token_hash" text,
	"phase" "discord_oauth_phase" DEFAULT 'pending' NOT NULL,
	"failure_code" "discord_oauth_failure",
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"flow" "discord_oauth_flow" NOT NULL,
	"guild_id" text,
	"redirect_uri" text NOT NULL,
	"verified_guild_id" varchar(20),
	"verified_guild_name" varchar(255),
	"verified_discord_user_id" varchar(20),
	"verified_bot_user_id" varchar(20),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	CONSTRAINT "discord_oauth_states_state_hash_unique" UNIQUE("state_hash"),
	CONSTRAINT "chk_discord_oauth_evidence_phase" CHECK ((
      "discord_oauth_states"."phase" IN ('verified', 'approved') AND
      "discord_oauth_states"."verified_guild_id" IS NOT NULL AND "discord_oauth_states"."verified_guild_name" IS NOT NULL AND
      "discord_oauth_states"."verified_discord_user_id" IS NOT NULL AND "discord_oauth_states"."verified_bot_user_id" IS NOT NULL
    ) OR (
      "discord_oauth_states"."phase" NOT IN ('verified', 'approved') AND
      "discord_oauth_states"."verified_guild_id" IS NULL AND "discord_oauth_states"."verified_guild_name" IS NULL AND
      "discord_oauth_states"."verified_discord_user_id" IS NULL AND "discord_oauth_states"."verified_bot_user_id" IS NULL
    )),
	CONSTRAINT "chk_discord_oauth_approval_phase" CHECK (("discord_oauth_states"."phase" = 'verified') = ("discord_oauth_states"."approval_token_hash" IS NOT NULL)),
	CONSTRAINT "chk_discord_oauth_failure_phase" CHECK (("discord_oauth_states"."phase" = 'failed') = ("discord_oauth_states"."failure_code" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "discord_user_identities" (
	"discord_user_id" varchar(255) PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "uq_discord_user_identity_owner" UNIQUE("discord_user_id","user_id")
);
--> statement-breakpoint
CREATE INDEX "idx_discord_oauth_states_expiry" ON "discord_oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_discord_oauth_states_owner" ON "discord_oauth_states" USING btree ("user_id","org_id");--> statement-breakpoint
-- Preserve verified owners; ambiguous cross-account senders fail closed rather than choosing an owner.
INSERT INTO "discord_user_identities" ("discord_user_id", "user_id")
SELECT DISTINCT "discord_user_id", "user_id" FROM "discord_org_connections";
--> statement-breakpoint
ALTER TABLE "discord_org_connections" ADD CONSTRAINT "fk_discord_connection_identity_owner" FOREIGN KEY ("discord_user_id","user_id") REFERENCES "public"."discord_user_identities"("discord_user_id","user_id") ON DELETE restrict ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "discord_org_connections" VALIDATE CONSTRAINT "fk_discord_connection_identity_owner";