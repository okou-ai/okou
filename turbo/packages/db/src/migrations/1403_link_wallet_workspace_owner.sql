ALTER TABLE "link_wallet_connections" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "link_wallet_oauth_attempts" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "link_wallet_oauth_attempts" ADD COLUMN "scope" varchar(16) DEFAULT 'agent' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_link_wallet_connections_owner" ON "link_wallet_connections" USING btree ("org_id","user_id") WHERE "link_wallet_connections"."agent_id" IS NULL;