-- Retire the Pi stable-context cache and keep only the storage publication
-- fence. An API built before this migration still writes the dropped and
-- renamed tables, so it fails on them until it drains; this is accepted.
-- Rollback below the API revision that adds this migration is unsupported.
ALTER TABLE "pi_resource_snapshots" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pi_stable_context_artifact_resources" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pi_stable_context_artifacts" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pi_stable_context_heads" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "pi_stable_context_heads" CASCADE;--> statement-breakpoint
DROP TABLE "pi_stable_context_artifact_resources" CASCADE;--> statement-breakpoint
DROP TABLE "pi_stable_context_artifacts" CASCADE;--> statement-breakpoint
DROP TABLE "pi_resource_snapshots" CASCADE;--> statement-breakpoint
ALTER TABLE "pi_stable_context_generations" RENAME TO "storage_publication_generations";--> statement-breakpoint
ALTER TABLE "pi_stable_context_publications" RENAME TO "storage_publication_tokens";--> statement-breakpoint
ALTER TABLE "storage_publication_generations" RENAME CONSTRAINT "pi_stable_context_generations_pk" TO "storage_publication_generations_pk";--> statement-breakpoint
ALTER TABLE "storage_publication_generations" RENAME CONSTRAINT "pi_stable_context_generations_generation_check" TO "storage_publication_generations_generation_check";--> statement-breakpoint
ALTER TABLE "storage_publication_generations" DROP CONSTRAINT "pi_stable_context_generations_state_check";--> statement-breakpoint
ALTER TABLE "storage_publication_generations" DROP COLUMN "publication_state";--> statement-breakpoint
ALTER TABLE "storage_publication_tokens" RENAME CONSTRAINT "pi_stable_context_publications_pk" TO "storage_publication_tokens_pk";--> statement-breakpoint
ALTER TABLE "storage_publication_tokens" RENAME CONSTRAINT "pi_stable_context_publications_generation_check" TO "storage_publication_tokens_generation_check";--> statement-breakpoint
ALTER INDEX "pi_stable_context_publications_token_idx" RENAME TO "storage_publication_tokens_token_idx";
