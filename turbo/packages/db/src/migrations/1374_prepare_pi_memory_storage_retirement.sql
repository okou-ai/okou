ALTER TABLE "pi_memory_phase2_jobs" DROP CONSTRAINT "pi_memory_phase2_jobs_version_ids_check";--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" DROP CONSTRAINT "pi_memory_phase2_jobs_execution_fence_check";--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" DROP CONSTRAINT "pi_memory_phase2_jobs_maintenance_history_check";--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" ADD CONSTRAINT "pi_memory_phase2_jobs_version_ids_check" CHECK (("pi_memory_phase2_jobs"."claimed_base_version_id" IS NULL OR "pi_memory_phase2_jobs"."claimed_base_version_id" ~ '^[0-9a-f]{64}$') AND
          ("pi_memory_phase2_jobs"."last_observed_head_version_id" IS NULL OR "pi_memory_phase2_jobs"."last_observed_head_version_id" ~ '^[0-9a-f]{64}$') AND
          ("pi_memory_phase2_jobs"."last_conflicting_head_version_id" IS NULL OR "pi_memory_phase2_jobs"."last_conflicting_head_version_id" ~ '^[0-9a-f]{64}$') AND
          ("pi_memory_phase2_jobs"."last_published_version_id" IS NULL OR "pi_memory_phase2_jobs"."last_published_version_id" ~ '^[0-9a-f]{64}$') AND
          ("pi_memory_phase2_jobs"."last_maintenance_base_version_id" IS NULL OR "pi_memory_phase2_jobs"."last_maintenance_base_version_id" ~ '^[0-9a-f]{64}$') AND
          ("pi_memory_phase2_jobs"."last_maintenance_selection_digest" IS NULL OR "pi_memory_phase2_jobs"."last_maintenance_selection_digest" ~ '^[0-9a-f]{64}$'));--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" ADD CONSTRAINT "pi_memory_phase2_jobs_execution_fence_check" CHECK ("pi_memory_phase2_jobs"."status" = 'leased' OR "pi_memory_phase2_jobs"."maintenance_run_id" IS NULL);--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" ADD CONSTRAINT "pi_memory_phase2_jobs_maintenance_history_check" CHECK ((
          "pi_memory_phase2_jobs"."last_maintenance_run_id" IS NULL AND
          "pi_memory_phase2_jobs"."last_maintenance_revision" IS NULL AND
          "pi_memory_phase2_jobs"."last_maintenance_base_version_id" IS NULL AND
          "pi_memory_phase2_jobs"."last_maintenance_selection_digest" IS NULL AND
          "pi_memory_phase2_jobs"."last_maintenance_outcome" IS NULL
        ) OR (
          "pi_memory_phase2_jobs"."last_maintenance_run_id" IS NOT NULL AND
          "pi_memory_phase2_jobs"."last_maintenance_revision" IS NOT NULL AND
          "pi_memory_phase2_jobs"."last_maintenance_revision" > 0 AND
          "pi_memory_phase2_jobs"."last_maintenance_base_version_id" IS NOT NULL AND
          "pi_memory_phase2_jobs"."last_maintenance_selection_digest" IS NOT NULL AND
          "pi_memory_phase2_jobs"."last_maintenance_outcome" IS NOT NULL AND
          "pi_memory_phase2_jobs"."last_maintenance_outcome" IN ('published', 'no_diff', 'failed') AND
          (
            "pi_memory_phase2_jobs"."last_maintenance_outcome" <> 'published' OR
            "pi_memory_phase2_jobs"."last_published_version_id" IS NOT NULL
          )
        ));