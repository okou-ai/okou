ALTER TABLE "model_provider_accounts" ADD COLUMN "atom_grant_id" uuid;--> statement-breakpoint
ALTER TABLE "model_provider_auth_sessions" ADD COLUMN "model_provider_account_id" uuid;