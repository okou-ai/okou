ALTER TABLE "link_wallet_connections" ADD COLUMN "oauth_requested_scopes" text;--> statement-breakpoint
ALTER TABLE "link_wallet_oauth_attempts" ADD COLUMN "oauth_requested_scopes" text;