-- Content-free diagnostic for #33975 / #33748, with no locks or row repair.
-- Run with psql -X --set ON_ERROR_STOP=1 on an authorized read-only connection.
-- Only candidate hashes are reconciled; this is not a global ledger repair.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '3s';
SET LOCAL search_path = public, pg_catalog;

  WITH candidate_owners AS MATERIALIZED (
    SELECT c.source_history_hash AS hash, b.ref_count,
      b.hash IS NULL AS missing_blob,
      s.id IS NULL AS missing_storage,
      s.org_id IS DISTINCT FROM c.org_id
        OR s.user_id IS DISTINCT FROM c.user_id AS invalid_owner,
      s.name IS DISTINCT FROM 'memory' OR s.user_id = '__org__' AS invalid_namespace,
      r.id IS NULL
        AND c.created_at < timestamp '2026-09-14 01:11:38'
        AND c.source_completed_at < timestamp '2026-09-14 01:11:38' AS old_deleted_source
    FROM pi_memory_stage1_candidates c
    LEFT JOIN blobs b ON b.hash = c.source_history_hash
    LEFT JOIN storages s ON s.id = c.memory_storage_id
    LEFT JOIN agent_runs r ON r.id = c.source_run_id
  ), candidate_refs AS MATERIALIZED (
    SELECT hash, count(*) AS refs, max(ref_count) AS ref_count,
      bool_and(old_deleted_source AND NOT missing_blob AND NOT missing_storage
        AND NOT invalid_owner AND NOT invalid_namespace) AS residual_eligible
    FROM candidate_owners GROUP BY hash
  ), conversation_refs AS (
    SELECT v.cli_agent_session_history_hash AS hash, count(*) AS refs
    FROM conversations v
    JOIN candidate_refs c ON c.hash = v.cli_agent_session_history_hash
    GROUP BY v.cli_agent_session_history_hash
  ), ledger AS (
    SELECT c.*, coalesce(v.refs, 0) AS conversation_refs,
      c.ref_count = c.refs + coalesce(v.refs, 0) AS balanced,
      c.refs = 1 AND c.ref_count = 2 AND coalesce(v.refs, 0) = 0
        AND c.residual_eligible AS classified_residual
    FROM candidate_refs c LEFT JOIN conversation_refs v USING (hash)
  ), integrity AS (
    SELECT count(*) AS candidate_rows,
      count(*) FILTER (WHERE missing_blob) AS missing_source_blobs,
      count(*) FILTER (WHERE missing_storage) AS missing_storage_owners,
      count(*) FILTER (WHERE invalid_owner) AS mismatched_storage_owners,
      count(*) FILTER (WHERE invalid_namespace) AS unexpected_storage_namespaces
    FROM candidate_owners
  ), reconciliation AS (
    SELECT count(*) AS candidate_hashes,
      count(*) FILTER (WHERE ref_count < 0) AS negative_candidate_blob_counts,
      count(*) FILTER (WHERE ref_count < refs) AS below_candidate_floor,
      count(*) FILTER (WHERE ref_count < refs + conversation_refs) AS below_known_owners,
      count(*) FILTER (WHERE balanced) AS balanced_hashes,
      count(*) FILTER (WHERE classified_residual) AS old_source_deleted_run_residuals,
      count(*) FILTER (WHERE NOT coalesce(balanced OR classified_residual, false)) AS unexplained_hashes
    FROM ledger
  ), trigger_state AS (
    SELECT count(*) AS user_triggers,
      count(*) FILTER (WHERE t.tgname = 'pi_memory_stage1_candidate_blob_ref_count_trigger'
        AND t.tgenabled = 'O' AND t.tgtype = 29
        AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgqual IS NULL
        AND t.tgnargs = 0 AND octet_length(t.tgargs) = 0
        AND t.tgattr::text = a.attnum::text
        AND p.proname = 'pi_memory_stage1_candidate_blob_ref_count'
        AND p.pronamespace = current_schema()::regnamespace
        AND p.proconfig IS NULL AND NOT p.prosecdef AND p.provolatile = 'v'
        AND p.prokind = 'f' AND NOT p.proretset AND NOT p.proisstrict
        AND NOT p.proleakproof AND p.proparallel = 'u'
        AND p.pronargs = 0 AND p.prorettype = 'trigger'::regtype
        AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
        AND md5(p.prosrc) = '576154890be37fff1ec9f9f4c318428c') AS expected_triggers
    FROM pg_trigger t
    JOIN pg_proc p ON p.oid = t.tgfoid
    JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attname = 'source_history_hash'
    WHERE t.tgrelid = 'pi_memory_stage1_candidates'::regclass
      AND NOT t.tgisinternal
  ), function_state AS (
    SELECT count(*) AS named_functions
    FROM pg_proc
    WHERE pronamespace = current_schema()::regnamespace
      AND proname = 'pi_memory_stage1_candidate_blob_ref_count'
  )
  SELECT jsonb_build_object(
    'receipt_version', 1,
    'transaction_read_only', current_setting('transaction_read_only'),
    'observed_at', statement_timestamp(),
    'server_version', current_setting('server_version'),
    'candidate_integrity', to_jsonb(i),
    'reconciliation', to_jsonb(r),
    'catalog', to_jsonb(t) || to_jsonb(f)
  ) AS pi_candidate_reference_audit
  FROM integrity i CROSS JOIN reconciliation r
    CROSS JOIN trigger_state t CROSS JOIN function_state f;
ROLLBACK;
