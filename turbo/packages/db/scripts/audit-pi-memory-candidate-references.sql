-- Content-free ownership audit for #33765 / #33748. Run with psql -X and
-- ON_ERROR_STOP=1 using an already-authorized read-only production connection.
-- No row IDs, hashes, owners, prompts, memory or history bytes leave PostgreSQL.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '3s';
SET LOCAL search_path = public, pg_catalog;

WITH candidate_refs AS MATERIALIZED (
  SELECT source_history_hash AS hash, count(*) AS refs
  FROM pi_memory_stage1_candidates
  GROUP BY source_history_hash
), conversation_refs AS MATERIALIZED (
  SELECT cli_agent_session_history_hash AS hash, count(*) AS refs
  FROM conversations
  WHERE cli_agent_session_history_hash IS NOT NULL
  GROUP BY cli_agent_session_history_hash
), ledger AS (
  SELECT b.hash, b.ref_count,
    coalesce(c.refs, 0) AS candidate_refs,
    coalesce(v.refs, 0) AS conversation_refs
  FROM blobs b
  LEFT JOIN candidate_refs c USING (hash)
  LEFT JOIN conversation_refs v USING (hash)
), candidate_integrity AS (
  SELECT count(*) AS candidate_rows,
    count(*) FILTER (WHERE b.hash IS NULL) AS missing_source_blobs,
    count(*) FILTER (WHERE s.id IS NULL) AS missing_storage_owners,
    count(*) FILTER (WHERE s.name <> 'memory' OR s.user_id = '__org__') AS unexpected_storage_namespaces
  FROM pi_memory_stage1_candidates c
  LEFT JOIN blobs b ON b.hash = c.source_history_hash
  LEFT JOIN storages s ON s.id = c.memory_storage_id
    AND s.org_id = c.org_id AND s.user_id = c.user_id
), trigger_state AS (
  SELECT count(*) AS user_triggers,
    count(*) FILTER (WHERE t.tgname = 'pi_memory_stage1_candidate_blob_ref_count_trigger'
      AND t.tgenabled = 'O' AND t.tgtype = 29
      AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgqual IS NULL
      AND t.tgnargs = 0 AND octet_length(t.tgargs) = 0
      AND t.tgattr::text = a.attnum::text
      AND p.proname = 'pi_memory_stage1_candidate_blob_ref_count'
      AND p.pronamespace = c.relnamespace
      AND p.proconfig IS NULL AND NOT p.prosecdef AND p.provolatile = 'v'
      AND p.pronargs = 0 AND p.prorettype = 'trigger'::regtype
      AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
      AND md5(p.prosrc) = '576154890be37fff1ec9f9f4c318428c') AS expected_triggers
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_proc p ON p.oid = t.tgfoid
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'source_history_hash'
  WHERE t.tgrelid = 'pi_memory_stage1_candidates'::regclass AND NOT t.tgisinternal
), reconciliation AS (
  SELECT count(*) AS blob_rows,
    count(*) FILTER (WHERE ref_count < 0) AS negative_blob_counts,
    count(*) FILTER (WHERE ref_count < candidate_refs) AS below_candidate_floor,
    count(*) FILTER (WHERE candidate_refs > 0 AND ref_count < candidate_refs + conversation_refs) AS candidate_hashes_below_known_owners,
    count(*) FILTER (WHERE candidate_refs > 0 AND ref_count > candidate_refs + conversation_refs) AS candidate_hashes_above_known_owners,
    count(*) FILTER (WHERE ref_count <> candidate_refs + conversation_refs) AS all_hashes_differing_from_known_owners
  FROM ledger
)
SELECT json_build_object(
  'observed_at', transaction_timestamp(),
  'server_version', current_setting('server_version'),
  'transaction_read_only', current_setting('transaction_read_only'),
  'candidate_integrity', row_to_json(i),
  'trigger_state', row_to_json(t),
  'reconciliation', row_to_json(r),
  'missing_conversation_blobs', (SELECT count(*) FROM conversation_refs v LEFT JOIN blobs b USING (hash) WHERE b.hash IS NULL)
) AS pi_candidate_reference_audit
FROM candidate_integrity i CROSS JOIN trigger_state t CROSS JOIN reconciliation r;
ROLLBACK;
