-- B acquires its candidate relation lock before deciding the accounting owner.
-- This MUST be a separate statement: the audit needs a snapshot taken after
-- any preceding B writer commits and this lock has actually been granted.
LOCK TABLE public.pi_memory_stage1_candidates IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  receipt jsonb;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed'
    OR current_setting('session_replication_role') <> 'origin' THEN
    RAISE EXCEPTION 'Pi candidate retirement requires read committed and origin';
  END IF;

  -- One snapshot for catalog, candidate integrity and all current owners of
  -- candidate hashes. Related tables use MVCC reads only: never lock storage
  -- or blob rows behind the candidate lock (B locks storage -> candidate -> blob).
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
    FROM public.pi_memory_stage1_candidates c
    LEFT JOIN public.blobs b ON b.hash = c.source_history_hash
    LEFT JOIN public.storages s ON s.id = c.memory_storage_id
    LEFT JOIN public.agent_runs r ON r.id = c.source_run_id
  ), candidate_refs AS MATERIALIZED (
    SELECT hash, count(*) AS refs, max(ref_count) AS ref_count,
      bool_and(old_deleted_source AND NOT missing_blob AND NOT missing_storage
        AND NOT invalid_owner AND NOT invalid_namespace) AS residual_eligible
    FROM candidate_owners GROUP BY hash
  ), conversation_refs AS (
    SELECT v.cli_agent_session_history_hash AS hash, count(*) AS refs
    FROM public.conversations v
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
        AND p.pronamespace = 'public'::regnamespace
        AND p.proconfig IS NULL AND NOT p.prosecdef AND p.provolatile = 'v'
        AND p.prokind = 'f' AND NOT p.proretset AND NOT p.proisstrict
        AND NOT p.proleakproof AND p.proparallel = 'u'
        AND p.pronargs = 0 AND p.prorettype = 'trigger'::regtype
        AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
        AND md5(p.prosrc) = '576154890be37fff1ec9f9f4c318428c') AS expected_triggers
    FROM pg_trigger t
    JOIN pg_proc p ON p.oid = t.tgfoid
    JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attname = 'source_history_hash'
    WHERE t.tgrelid = 'public.pi_memory_stage1_candidates'::regclass
      AND NOT t.tgisinternal
  ), function_state AS (
    SELECT count(*) AS named_functions
    FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname = 'pi_memory_stage1_candidate_blob_ref_count'
  )
  SELECT jsonb_build_object(
    'receipt_version', 1,
    'observed_at', statement_timestamp(),
    'server_version', current_setting('server_version'),
    'candidate_integrity', to_jsonb(i),
    'reconciliation', to_jsonb(r),
    'pre_drop_catalog', to_jsonb(t) || to_jsonb(f)
  ) INTO receipt
  FROM integrity i CROSS JOIN reconciliation r
    CROSS JOIN trigger_state t CROSS JOIN function_state f;

  IF receipt #>> '{pre_drop_catalog,user_triggers}' <> '1'
    OR receipt #>> '{pre_drop_catalog,expected_triggers}' <> '1'
    OR receipt #>> '{pre_drop_catalog,named_functions}' <> '1' THEN
    RAISE EXCEPTION 'Unexpected Pi candidate retirement catalog configuration';
  END IF;
  IF receipt #>> '{candidate_integrity,missing_source_blobs}' <> '0'
    OR receipt #>> '{candidate_integrity,missing_storage_owners}' <> '0'
    OR receipt #>> '{candidate_integrity,mismatched_storage_owners}' <> '0'
    OR receipt #>> '{candidate_integrity,unexpected_storage_namespaces}' <> '0'
    OR receipt #>> '{reconciliation,unexplained_hashes}' <> '0' THEN
    RAISE EXCEPTION 'Pi candidate retirement ownership audit failed';
  END IF;

  DROP TRIGGER pi_memory_stage1_candidate_blob_ref_count_trigger
    ON public.pi_memory_stage1_candidates;
  DROP FUNCTION public.pi_memory_stage1_candidate_blob_ref_count();

  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.pi_memory_stage1_candidates'::regclass AND NOT tgisinternal
  ) OR EXISTS (
    SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
      AND proname = 'pi_memory_stage1_candidate_blob_ref_count'
  ) THEN
    RAISE EXCEPTION 'Pi candidate retirement post-drop absence assertion failed';
  END IF;

  -- postgres.js forwards NOTICE through the existing migration logging path.
  -- Only the subsequent atomic journal commit / Migrations complete confirms
  -- success: a NOTICE followed by a failure is never a committed-drop receipt.
  RAISE NOTICE 'pi_candidate_retirement_v1 %', receipt || jsonb_build_object(
    'post_drop_absent', true, 'transaction_status', 'pending_commit');
END
$$;
