-- #34230: aggregate observations, never a repair manifest.
-- Run this whole file in a fresh psql -X session with ON_ERROR_STOP=1.
-- Revalidate docs/database/historical-session-blob-audit.md before execution.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '3s';
SET LOCAL idle_in_transaction_session_timeout = '15s';
SET LOCAL work_mem = '16MB';
SET LOCAL hash_mem_multiplier = 2;
SET LOCAL max_parallel_workers_per_gather = 0;
SET LOCAL jit = off;
SET LOCAL row_security = off;
SET LOCAL timezone = 'UTC';
SET LOCAL search_path = pg_catalog, public;

-- Audit query: one statement, including all populations and catalog observations.
WITH parameters AS MATERIALIZED (
  SELECT statement_timestamp() AS observed_at,
    statement_timestamp() AT TIME ZONE 'UTC' - interval '24 hours' AS recent_cutoff,
    timestamp '2026-09-14 01:11:38' AS old_b_cutoff
), candidate_owners AS MATERIALIZED (
  SELECT c.source_history_hash AS hash,
    s.id IS NULL AS missing_storage,
    s.org_id IS DISTINCT FROM c.org_id
      OR s.user_id IS DISTINCT FROM c.user_id AS invalid_owner,
    s.name IS DISTINCT FROM 'memory' OR s.user_id = '__org__' AS invalid_namespace,
    r.id IS NULL AS missing_source_run,
    r.id IS NULL AND c.created_at < p.old_b_cutoff
      AND c.source_completed_at < p.old_b_cutoff AS old_deleted_source,
    greatest(c.created_at, c.updated_at, c.source_completed_at) >= p.recent_cutoff
      OR c.status IN ('pending', 'leased', 'retryable_failure') AS recent_or_active,
    NOT isfinite(c.created_at) OR NOT isfinite(c.updated_at)
      OR NOT isfinite(c.source_completed_at) AS unknown_time
  FROM public.pi_memory_stage1_candidates c
  CROSS JOIN parameters p
  LEFT JOIN public.storages s ON s.id = c.memory_storage_id
  LEFT JOIN public.agent_runs r ON r.id = c.source_run_id
), candidate_refs AS MATERIALIZED (
  SELECT hash, count(*) AS refs,
    bool_and(old_deleted_source AND NOT missing_storage
      AND NOT invalid_owner AND NOT invalid_namespace) AS residual_pattern,
    bool_or(recent_or_active) AS recent_or_active,
    bool_or(unknown_time) AS unknown_time
  FROM candidate_owners GROUP BY hash
), conversation_refs AS MATERIALIZED (
  -- Keep the NULL group for legacy/null coverage, but it owns no blob.
  -- Only nullness of inline history is read; its contents never enter a result.
  SELECT v.cli_agent_session_history_hash AS hash, count(*) AS refs,
    count(*) FILTER (WHERE v.cli_agent_session_history IS NOT NULL) AS inline_rows,
    bool_or(v.created_at >= p.recent_cutoff) AS recent,
    bool_or(NOT isfinite(v.created_at)) AS unknown_time
  FROM public.conversations v CROSS JOIN parameters p
  GROUP BY v.cli_agent_session_history_hash
), owners AS (
  SELECT coalesce(v.hash, c.hash) AS hash,
    coalesce(v.refs, 0) AS conversation_refs,
    coalesce(c.refs, 0) AS candidate_refs,
    coalesce(c.residual_pattern, false) AS residual_pattern,
    coalesce(v.recent, false) OR coalesce(c.recent_or_active, false) AS recent_or_active,
    coalesce(v.unknown_time, false) OR coalesce(c.unknown_time, false) AS unknown_time
  FROM conversation_refs v FULL JOIN candidate_refs c USING (hash)
  WHERE coalesce(v.hash, c.hash) IS NOT NULL
), ledger AS MATERIALIZED (
  -- FULL JOIN retains owners whose blob metadata is missing, plus unowned blobs.
  SELECT coalesce(b.hash, o.hash) AS hash, b.hash IS NULL AS missing_metadata,
    b.ref_count,
    coalesce(o.conversation_refs, 0) AS conversation_refs,
    coalesce(o.candidate_refs, 0) AS candidate_refs,
    coalesce(o.conversation_refs, 0) + coalesce(o.candidate_refs, 0) AS owner_refs,
    coalesce(o.residual_pattern, false) AND o.candidate_refs = 1
      AND o.conversation_refs = 0 AND b.ref_count = 2 AS old_candidate_residual,
    coalesce(o.recent_or_active, false)
      OR coalesce(b.created_at >= p.recent_cutoff, false) AS recent_or_active,
    coalesce(o.unknown_time, false)
      OR coalesce(NOT isfinite(b.created_at), false) AS unknown_time
  FROM public.blobs b FULL JOIN owners o USING (hash)
  CROSS JOIN parameters p
), population AS (
  SELECT count(*) AS union_hashes,
    count(*) FILTER (WHERE NOT missing_metadata) AS blob_rows,
    count(*) FILTER (WHERE owner_refs > 0) AS owned_hashes,
    coalesce(sum(owner_refs), 0) AS owner_references,
    coalesce(sum(conversation_refs), 0) AS conversation_references,
    coalesce(sum(candidate_refs), 0) AS candidate_references,
    count(*) FILTER (WHERE owner_refs > 1) AS shared_hashes,
    count(*) FILTER (WHERE conversation_refs > 1) AS shared_conversation_hashes,
    count(*) FILTER (WHERE candidate_refs > 1) AS shared_candidate_hashes,
    count(*) FILTER (WHERE conversation_refs > 0 AND candidate_refs > 0) AS cross_owner_hashes,
    coalesce(max(owner_refs), 0) AS maximum_owner_multiplicity,
    count(*) FILTER (WHERE hash !~ '^[0-9a-f]{64}$') AS unrecognized_hash_format,
    coalesce(sum(ref_count), 0) AS recorded_references
  FROM ledger
), reconciliation AS (
  -- These observations overlap: e.g. a negative count can also be under-retained.
  SELECT count(*) FILTER (WHERE owner_refs > 0 AND ref_count = owner_refs) AS balanced_owned_hashes,
    count(*) FILTER (WHERE missing_metadata) AS missing_metadata_hashes,
    coalesce(sum(owner_refs) FILTER (WHERE missing_metadata), 0) AS missing_metadata_references,
    count(*) FILTER (WHERE ref_count < 0) AS negative_hashes,
    count(*) FILTER (WHERE owner_refs > 0 AND ref_count < owner_refs) AS under_retained_hashes,
    coalesce(sum(owner_refs - ref_count) FILTER (
      WHERE owner_refs > 0 AND ref_count < owner_refs), 0) AS under_retained_difference,
    count(*) FILTER (WHERE owner_refs > 0 AND ref_count > owner_refs) AS excess_owned_hashes,
    count(*) FILTER (WHERE owner_refs = 0 AND ref_count > 0) AS positive_unowned_hashes,
    count(*) FILTER (WHERE ref_count > owner_refs) AS all_excess_hashes,
    coalesce(sum(ref_count - owner_refs) FILTER (
      WHERE ref_count > owner_refs), 0) AS excess_reference_difference,
    count(*) FILTER (WHERE owner_refs = 0 AND ref_count = 0) AS unowned_zero_count_metadata,
    count(*) FILTER (WHERE recent_or_active) AS recent_or_active_hashes,
    count(*) FILTER (WHERE unknown_time) AS nonfinite_time_hashes,
    count(*) FILTER (WHERE ref_count > owner_refs AND recent_or_active) AS recent_or_active_excess_hashes,
    count(*) FILTER (WHERE ref_count > owner_refs AND NOT recent_or_active) AS older_observed_excess_hashes,
    count(*) FILTER (WHERE ref_count > owner_refs) AS excess_hashes_with_unknown_counter_history
  FROM ledger
), candidate_reconciliation AS (
  -- Same ownership and old-source conjunction as the unchanged candidate audit.
  SELECT count(*) AS candidate_hashes,
    count(*) FILTER (WHERE missing_metadata) AS missing_source_hashes,
    coalesce(sum(candidate_refs) FILTER (WHERE missing_metadata), 0) AS missing_source_blobs,
    count(*) FILTER (WHERE ref_count < 0) AS negative_candidate_blob_counts,
    count(*) FILTER (WHERE ref_count < candidate_refs) AS below_candidate_floor,
    count(*) FILTER (WHERE ref_count < owner_refs) AS below_known_owners,
    count(*) FILTER (WHERE ref_count = owner_refs) AS balanced_hashes,
    count(*) FILTER (WHERE old_candidate_residual) AS old_source_deleted_run_residuals,
    count(*) FILTER (WHERE NOT coalesce(ref_count = owner_refs OR old_candidate_residual, false)) AS unexplained_hashes
  FROM ledger WHERE candidate_refs > 0
), candidate_integrity AS (
  SELECT count(*) AS candidate_rows,
    count(*) FILTER (WHERE missing_storage) AS missing_storage_owners,
    count(*) FILTER (WHERE invalid_owner) AS mismatched_storage_owners,
    count(*) FILTER (WHERE invalid_namespace) AS unexpected_storage_namespaces,
    count(*) FILTER (WHERE missing_source_run) AS absent_source_runs
  FROM candidate_owners
), conversation_integrity AS (
  SELECT coalesce(sum(refs), 0) AS conversation_rows,
    coalesce(sum(refs - inline_rows) FILTER (WHERE hash IS NULL), 0) AS null_history_rows,
    coalesce(sum(inline_rows) FILTER (WHERE hash IS NULL), 0) AS legacy_inline_only_rows,
    coalesce(sum(inline_rows) FILTER (WHERE hash IS NOT NULL), 0) AS hash_with_inline_rows
  FROM conversation_refs
), blob_foreign_keys AS (
  SELECT c.conrelid = 'public.pi_memory_stage1_candidates'::regclass
    AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute
      WHERE attrelid = c.conrelid AND attname = 'source_history_hash')]
    AND c.confkey = ARRAY[(SELECT attnum FROM pg_attribute
      WHERE attrelid = c.confrelid AND attname = 'hash')]
    AND c.convalidated AS expected
  FROM pg_constraint c
  WHERE c.contype = 'f' AND c.confrelid = 'public.blobs'::regclass
), catalog AS (
  SELECT
    (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal
      AND tgrelid IN ('public.blobs'::regclass, 'public.conversations'::regclass,
        'public.pi_memory_stage1_candidates'::regclass)) AS owner_table_user_triggers,
    (SELECT count(*) FROM blob_foreign_keys WHERE expected) AS expected_candidate_blob_foreign_keys,
    (SELECT count(*) FROM blob_foreign_keys WHERE NOT expected) AS unexpected_blob_foreign_keys,
    (SELECT count(*) FROM pg_class
      WHERE oid IN ('public.blobs'::regclass, 'public.conversations'::regclass,
        'public.pi_memory_stage1_candidates'::regclass, 'public.storages'::regclass,
        'public.agent_runs'::regclass) AND (relrowsecurity OR relkind <> 'r')) AS unexpected_relation_configuration
)
SELECT jsonb_build_object(
  'receipt_version', 'historical_session_blob_references_v1',
  'inventory_revision', '22d0e7c82658704920587dd12c471780a9850684',
  'scope', 'all public.blobs union all non-null conversation and candidate source hashes',
  'observed_at', p.observed_at,
  'finished_at', clock_timestamp(),
  'statement_elapsed_ms', extract(epoch FROM clock_timestamp() - p.observed_at) * 1000,
  'server_version', current_setting('server_version'),
  'transaction', jsonb_build_object(
    'read_only', current_setting('transaction_read_only'),
    'isolation', current_setting('transaction_isolation'),
    'started_at', transaction_timestamp(),
    'ending', 'rollback',
    'statement_timeout', current_setting('statement_timeout'),
    'lock_timeout', current_setting('lock_timeout'),
    'idle_timeout', current_setting('idle_in_transaction_session_timeout'),
    'work_mem', current_setting('work_mem'),
    'hash_mem_multiplier', current_setting('hash_mem_multiplier'),
    'parallel_workers', current_setting('max_parallel_workers_per_gather'),
    'row_security', current_setting('row_security')),
  'cutoffs', jsonb_build_object(
    'timezone', 'UTC', 'recent_window_hours', 24,
    'recent_observation_cutoff', p.recent_cutoff,
    'old_candidate_b_cutoff', p.old_b_cutoff,
    -- Fail without a receipt if the fixed historical cutoff is in the future.
    'validated', 1 / CASE WHEN isfinite(p.old_b_cutoff)
      AND p.old_b_cutoff < p.observed_at AT TIME ZONE 'UTC'
      AND p.recent_cutoff < p.observed_at AT TIME ZONE 'UTC' THEN 1 ELSE 0 END = 1),
  'assumptions', jsonb_build_object(
    'persisted_owners', jsonb_build_array('conversations', 'pi_memory_stage1_candidates'),
    'catalog_matches_inventory', k.owner_table_user_triggers = 0
      AND k.expected_candidate_blob_foreign_keys = 1
      AND k.unexpected_blob_foreign_keys = 0 AND k.unexpected_relation_configuration = 0,
    'current_writer_and_rollout_revalidation_required', true,
    'out_of_repository_writers_verified', false,
    'object_existence_verified', false,
    'counter_mutation_timestamps_available', false,
    'conversation_hash_replacement_timestamps_available', false,
    'differences_authorize_repair', false),
  'population', to_jsonb(n),
  'reconciliation', to_jsonb(a),
  'conversations', to_jsonb(v),
  'candidate_only', to_jsonb(c) || to_jsonb(i),
  'catalog', to_jsonb(k)
) AS historical_session_blob_reference_audit
FROM parameters p CROSS JOIN population n CROSS JOIN reconciliation a
  CROSS JOIN candidate_reconciliation c CROSS JOIN candidate_integrity i
  CROSS JOIN conversation_integrity v CROSS JOIN catalog k;
ROLLBACK;
