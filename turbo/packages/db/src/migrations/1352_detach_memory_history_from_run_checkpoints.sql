ALTER TABLE "pi_memory_phase2_jobs" DROP CONSTRAINT "pi_memory_phase2_jobs_maintenance_history_check";--> statement-breakpoint
ALTER TABLE "pi_memory_phase2_jobs" ADD CONSTRAINT "pi_memory_phase2_jobs_maintenance_history_check" CHECK ((
          "pi_memory_phase2_jobs"."last_maintenance_run_id" IS NULL AND
          "pi_memory_phase2_jobs"."last_maintenance_revision" IS NULL AND
          "pi_memory_phase2_jobs"."last_maintenance_base_version_id" IS NULL AND
          "pi_memory_phase2_jobs"."last_maintenance_selection_digest" IS NULL AND
          "pi_memory_phase2_jobs"."last_maintenance_checkpoint_version_id" IS NULL AND
          "pi_memory_phase2_jobs"."last_maintenance_outcome" IS NULL
        ) OR (
          "pi_memory_phase2_jobs"."last_maintenance_run_id" IS NOT NULL AND
          "pi_memory_phase2_jobs"."last_maintenance_revision" IS NOT NULL AND
          "pi_memory_phase2_jobs"."last_maintenance_revision" > 0 AND
          "pi_memory_phase2_jobs"."last_maintenance_base_version_id" IS NOT NULL AND
          "pi_memory_phase2_jobs"."last_maintenance_selection_digest" IS NOT NULL AND
          "pi_memory_phase2_jobs"."last_maintenance_outcome" IN ('published', 'no_diff', 'failed') AND
          (
            (
              "pi_memory_phase2_jobs"."last_maintenance_outcome" = 'failed' AND
              "pi_memory_phase2_jobs"."last_maintenance_checkpoint_version_id" IS NULL
            ) OR (
              "pi_memory_phase2_jobs"."last_maintenance_outcome" IN ('published', 'no_diff') AND
              "pi_memory_phase2_jobs"."last_maintenance_checkpoint_version_id" IS NOT NULL
            )
          )
        ));