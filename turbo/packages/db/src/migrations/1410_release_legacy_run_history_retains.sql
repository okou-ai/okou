-- vm0:non-transactional
-- Release only Run-owned archive retains; keep Runs, Memory and blob metadata.
-- v5 no longer produces remote native History. The supported rollback floor
-- already requires native continuation; these hashes never authorize resume.
-- Each batch commits independently and a retry starts again at the first UUID.
-- Build a migration-owned lookup before applying the short batch deadline.
-- Retrying a failed concurrent build must replace its possibly invalid index.
SET statement_timeout = '5min';
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS public.migration_1410_run_history_hash_idx;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY migration_1410_run_history_hash_idx
  ON public.agent_runs (legacy_conversation_history_hash)
  WHERE legacy_conversation_history_hash IS NOT NULL;
--> statement-breakpoint
ANALYZE public.agent_runs (legacy_conversation_history_hash);
--> statement-breakpoint
SET statement_timeout = '2s';
--> statement-breakpoint
-- vm0:batch-by-uuid
WITH batch AS MATERIALIZED (
  SELECT id, legacy_conversation_history_hash AS hash
  FROM agent_runs
  WHERE ($1::uuid IS NULL OR id > $1::uuid)
    AND legacy_conversation_history_hash IS NOT NULL
  ORDER BY id
  LIMIT 500
), target_hashes AS MATERIALIZED (
  SELECT DISTINCT hash FROM batch
), run_refs AS MATERIALIZED (
  SELECT r.legacy_conversation_history_hash AS hash, count(*) AS refs
  FROM agent_runs r
  JOIN target_hashes t ON t.hash = r.legacy_conversation_history_hash
  GROUP BY r.legacy_conversation_history_hash
), memory_refs AS MATERIALIZED (
  -- Every candidate status owns its input; frozen selections own no extra retain.
  SELECT c.source_history_hash AS hash, count(*) AS refs
  FROM pi_memory_stage1_candidates c
  JOIN target_hashes t ON t.hash = c.source_history_hash
  GROUP BY c.source_history_hash
), balanced AS MATERIALIZED (
  -- Isolate missing, under-retained and excess-retained hashes for later review.
  -- Unknown owners and unrelated zero-ref metadata are never cleanup targets.
  SELECT b.hash
  FROM blobs b
  JOIN run_refs r ON r.hash = b.hash
  LEFT JOIN memory_refs m ON m.hash = b.hash
  WHERE b.ref_count = r.refs + coalesce(m.refs, 0)
), cleared AS (
  UPDATE agent_runs r
  SET legacy_conversation_history_hash = NULL
  FROM batch b, balanced
  WHERE r.id = b.id
    AND r.legacy_conversation_history_hash = b.hash
    AND balanced.hash = b.hash
    AND r.status IN ('completed', 'failed', 'cancelled', 'timeout')
    AND r.completed_at IS NOT NULL
    AND (r.launch_snapshot->>'schemaVersion' IS NULL
      OR r.launch_snapshot->>'schemaVersion' IN ('1', '2', '3', '4'))
    -- Conservatively preserve possible future legacy Pi Memory admission.
    -- Recheck on the winning Run row, rather than clearing a captured old value.
    AND NOT (
      r.status = 'completed' AND r.chat_thread_id IS NOT NULL
      AND r.completed_at >= (statement_timestamp() AT TIME ZONE 'UTC') - interval '10 days'
      AND coalesce(r.launch_snapshot->>'framework', r.framework, '') = 'pi'
    )
  RETURNING b.hash
), releases AS MATERIALIZED (
  -- Only the winning clear owns a decrement, including concurrent deletion/replay.
  SELECT hash, count(*)::integer AS refs FROM cleared GROUP BY hash
), released AS (
  UPDATE blobs b
  SET ref_count = b.ref_count - releases.refs
  FROM releases
  WHERE b.hash = releases.hash AND b.ref_count >= releases.refs
  RETURNING releases.refs
)
SELECT CASE
  WHEN (SELECT count(*) FROM cleared) = (SELECT coalesce(sum(refs), 0) FROM released)
  THEN (SELECT id FROM batch ORDER BY id DESC LIMIT 1)
  -- Abort this entire statement if metadata vanished or a concurrent counter
  -- change cannot cover its winning clears. Earlier committed batches survive.
  ELSE format('History retain accounting mismatch: cleared=%s released=%s',
    (SELECT count(*) FROM cleared), (SELECT coalesce(sum(refs), 0) FROM released))::uuid
END AS next_cursor;
--> statement-breakpoint
SET statement_timeout = '5min';
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS public.migration_1410_run_history_hash_idx;
--> statement-breakpoint
RESET statement_timeout;
