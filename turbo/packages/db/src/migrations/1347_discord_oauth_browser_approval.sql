CREATE TYPE "public"."discord_oauth_failure" AS ENUM('cancelled', 'unavailable', 'forbidden', 'provider_error', 'invalid_authorization', 'guild_unverified', 'bot_missing');--> statement-breakpoint
CREATE TYPE "public"."discord_oauth_phase" AS ENUM('pending', 'processing', 'verified', 'approved', 'failed');--> statement-breakpoint
ALTER TABLE "discord_oauth_states" RENAME COLUMN "browser_hash" TO "completion_token_hash";--> statement-breakpoint
ALTER TABLE "discord_oauth_states" ADD COLUMN "approval_token_hash" text;--> statement-breakpoint
ALTER TABLE "discord_oauth_states" ADD COLUMN "phase" "discord_oauth_phase" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "discord_oauth_states" ADD COLUMN "failure_code" "discord_oauth_failure";--> statement-breakpoint
ALTER TABLE "discord_oauth_states" ADD COLUMN "verified_guild_id" varchar(20);--> statement-breakpoint
ALTER TABLE "discord_oauth_states" ADD COLUMN "verified_guild_name" varchar(255);--> statement-breakpoint
ALTER TABLE "discord_oauth_states" ADD COLUMN "verified_discord_user_id" varchar(20);--> statement-breakpoint
ALTER TABLE "discord_oauth_states" ADD COLUMN "verified_bot_user_id" varchar(20);--> statement-breakpoint
ALTER TABLE "discord_oauth_states" ADD CONSTRAINT "chk_discord_oauth_evidence_phase" CHECK ((
      "discord_oauth_states"."phase" IN ('verified', 'approved') AND
      "discord_oauth_states"."verified_guild_id" IS NOT NULL AND "discord_oauth_states"."verified_guild_name" IS NOT NULL AND
      "discord_oauth_states"."verified_discord_user_id" IS NOT NULL AND "discord_oauth_states"."verified_bot_user_id" IS NOT NULL
    ) OR (
      "discord_oauth_states"."phase" NOT IN ('verified', 'approved') AND
      "discord_oauth_states"."verified_guild_id" IS NULL AND "discord_oauth_states"."verified_guild_name" IS NULL AND
      "discord_oauth_states"."verified_discord_user_id" IS NULL AND "discord_oauth_states"."verified_bot_user_id" IS NULL
    ));--> statement-breakpoint
ALTER TABLE "discord_oauth_states" ADD CONSTRAINT "chk_discord_oauth_approval_phase" CHECK (("discord_oauth_states"."phase" = 'verified') = ("discord_oauth_states"."approval_token_hash" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "discord_oauth_states" ADD CONSTRAINT "chk_discord_oauth_failure_phase" CHECK (("discord_oauth_states"."phase" = 'failed') = ("discord_oauth_states"."failure_code" IS NOT NULL));