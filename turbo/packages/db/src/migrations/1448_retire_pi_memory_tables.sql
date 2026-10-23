-- The storage-independent API is already serving and its predecessor drained.
-- Apply this contraction in the ordinary pre-promotion migration batch.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pi_memory_stage1_candidates WHERE status = 'leased')
    OR EXISTS (
      SELECT 1 FROM pi_memory_phase2_jobs
      WHERE status = 'leased' OR maintenance_run_id IS NOT NULL
    )
    OR EXISTS (SELECT 1 FROM memory_summary_projections WHERE status = 'running')
  THEN
    RAISE EXCEPTION 'Pi memory retirement requires extraction, maintenance and projection leases to drain';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM agent_run_callbacks AS callback
    LEFT JOIN agent_runs AS run ON run.id = callback.run_id
    WHERE callback.internal_kind = 'pi-memory:phase2'
      AND (
        callback.status <> 'delivered'
        OR run.completed_at IS NULL
        OR run.status NOT IN ('completed', 'failed', 'cancelled', 'timeout')
        OR run.completed_at > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '2 hours 2 minutes'
      )
  ) THEN
    RAISE EXCEPTION 'Pi memory retirement requires terminal callbacks and late usage to drain';
  END IF;

  IF EXISTS (
    SELECT 1 FROM usage_event AS event
    WHERE event.processed_at IS NULL
      AND (
        event.billing_context = 'pi_memory_stage1'
        OR EXISTS (
          SELECT 1 FROM agent_run_callbacks AS callback
          WHERE callback.internal_kind = 'pi-memory:phase2'
            AND (callback.run_id = event.run_id OR callback.run_id = event.billing_run_id)
        )
      )
  ) THEN
    RAISE EXCEPTION 'Pi memory retirement requires outstanding usage settlement';
  END IF;
END
$$;
--> statement-breakpoint
-- Every candidate owns one source-history retain, including multiple candidates
-- sharing one hash. Preserve native history and every other owner's retains.
DO $$
DECLARE
  expected_blobs bigint;
  released_blobs bigint;
BEGIN
  SELECT COUNT(DISTINCT source_history_hash)
  INTO expected_blobs
  FROM pi_memory_stage1_candidates;

  UPDATE blobs AS blob
  SET ref_count = blob.ref_count - retained.retains::integer
  FROM (
    SELECT source_history_hash, COUNT(*) AS retains
    FROM pi_memory_stage1_candidates
    GROUP BY source_history_hash
  ) AS retained
  WHERE blob.hash = retained.source_history_hash
    AND blob.ref_count >= retained.retains;

  GET DIAGNOSTICS released_blobs = ROW_COUNT;
  IF released_blobs <> expected_blobs THEN
    RAISE EXCEPTION 'Pi memory candidate blob retains are missing or undercounted';
  END IF;
END
$$;
--> statement-breakpoint
DELETE FROM agent_run_callbacks WHERE internal_kind = 'pi-memory:phase2';
--> statement-breakpoint
UPDATE user_feature_switches
SET switches = switches - 'piMemory'
WHERE switches ? 'piMemory';
--> statement-breakpoint
DROP INDEX "idx_agent_run_callbacks_pi_memory";
--> statement-breakpoint
-- RESTRICT is intentional: unexpected consumers must stop the contraction.
DROP TABLE "memory_summary_projections";
--> statement-breakpoint
DROP TABLE "pi_memory_publication_provenance";
--> statement-breakpoint
DROP TABLE "pi_memory_phase2_jobs";
--> statement-breakpoint
DROP TABLE "pi_memory_stage1_watermarks";
--> statement-breakpoint
DROP TABLE "pi_memory_stage1_selections";
--> statement-breakpoint
DROP TABLE "pi_memory_stage1_days";
--> statement-breakpoint
DROP TABLE "pi_memory_stage1_candidates";
