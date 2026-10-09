CREATE TYPE "public"."discord_oauth_failure" AS ENUM('cancelled', 'unavailable', 'forbidden', 'provider_error', 'invalid_authorization', 'guild_unverified', 'bot_missing');--> statement-breakpoint
CREATE TYPE "public"."discord_oauth_flow" AS ENUM('install', 'connect');--> statement-breakpoint
CREATE TYPE "public"."discord_oauth_phase" AS ENUM('pending', 'processing', 'verified', 'approved', 'failed');--> statement-breakpoint
CREATE TABLE "discord_oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state_hash" text NOT NULL,
	"completion_token_hash" text,
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
	CONSTRAINT "uq_discord_oauth_grant_owner" UNIQUE("id","user_id","verified_discord_user_id","verified_guild_id"),
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
-- Non-GA Discord requires genuine personal and organization consent. Existing
-- staff bindings must be removed through their owner-facing lifecycle before
-- this migration. Missing lineage fails closed; never fabricate grants or erase
-- existing data to make migration succeed.
ALTER TABLE "discord_org_connections" ADD COLUMN "oauth_grant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "discord_org_installations" ADD COLUMN "org_grant_id" uuid NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_discord_oauth_states_expiry" ON "discord_oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_discord_oauth_states_owner" ON "discord_oauth_states" USING btree ("user_id","org_id");--> statement-breakpoint
CREATE INDEX "idx_discord_org_grants_org" ON "discord_org_grants" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_discord_org_grants_initiator" ON "discord_org_grants" USING btree ("initiated_by_user_id");--> statement-breakpoint
CREATE INDEX "idx_discord_org_grants_expiry" ON "discord_org_grants" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "discord_org_connections" ADD CONSTRAINT "fk_discord_connection_oauth_grant" FOREIGN KEY ("oauth_grant_id","user_id","discord_user_id","guild_id") REFERENCES "public"."discord_oauth_states"("id","user_id","verified_discord_user_id","verified_guild_id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "discord_org_connections" VALIDATE CONSTRAINT "fk_discord_connection_oauth_grant";--> statement-breakpoint
ALTER TABLE "discord_org_installations" ADD CONSTRAINT "fk_discord_installation_org_grant" FOREIGN KEY ("org_grant_id","org_id","guild_id","bot_user_id","created_at") REFERENCES "public"."discord_org_grants"("id","org_id","verified_guild_id","verified_bot_user_id","approved_at") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "discord_org_installations" VALIDATE CONSTRAINT "fk_discord_installation_org_grant";--> statement-breakpoint
ALTER TABLE "discord_org_installations" ADD CONSTRAINT "fk_discord_installation_grant_installer" FOREIGN KEY ("org_grant_id","installed_by_user_id") REFERENCES "public"."discord_org_grants"("id","initiated_by_user_id") ON DELETE cascade ON UPDATE cascade NOT VALID;--> statement-breakpoint
ALTER TABLE "discord_org_installations" VALIDATE CONSTRAINT "fk_discord_installation_grant_installer";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
ALTER TABLE "discord_org_connections" ADD CONSTRAINT "ex_discord_connections_global_sender_owner"
  EXCLUDE USING gist ("discord_user_id" WITH =, "user_id" WITH <>);