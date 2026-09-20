ALTER TABLE "built_in_model_candidate_cooldown" RENAME COLUMN "provider_type" TO "model_runtime_provider";--> statement-breakpoint
ALTER TABLE "built_in_model_candidate_cooldown" RENAME COLUMN "upstream_model" TO "model_runtime_model";--> statement-breakpoint
ALTER TABLE "built_in_model_candidate_cooldown" RENAME CONSTRAINT "built_in_model_candidate_cooldown_selected_model_provider_type_" TO "built_in_model_candidate_cooldown_selected_model_model_runtime_";
