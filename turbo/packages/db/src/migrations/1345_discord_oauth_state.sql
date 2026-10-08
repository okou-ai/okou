CREATE TYPE "public"."discord_oauth_flow" AS ENUM('install', 'connect');--> statement-breakpoint
CREATE TABLE "discord_oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state_hash" text NOT NULL,
	"browser_hash" text NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"flow" "discord_oauth_flow" NOT NULL,
	"guild_id" text,
	"redirect_uri" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	CONSTRAINT "discord_oauth_states_state_hash_unique" UNIQUE("state_hash")
);
--> statement-breakpoint
CREATE INDEX "idx_discord_oauth_states_expiry" ON "discord_oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_discord_oauth_states_owner" ON "discord_oauth_states" USING btree ("user_id","org_id");