ALTER TABLE "computer_use_hosts" ALTER COLUMN "token_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "computer_use_commands" ADD COLUMN "claimed_connection_generation" integer;--> statement-breakpoint
ALTER TABLE "computer_use_hosts" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "computer_use_hosts" ADD COLUMN "session_validated_at" timestamp;--> statement-breakpoint
ALTER TABLE "computer_use_hosts" ADD COLUMN "connection_generation" integer DEFAULT 0 NOT NULL;