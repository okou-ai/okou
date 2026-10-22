-- Historical #37970 preflight for the pre-retirement schema, retained for audit.
-- Not runnable after session/conversation or Pi memory tables are retired.
-- Read-only production preflight; counts and catalog names only.
-- Run using the previously authorized production read-only SQL connection.
-- No history/message bodies, hashes, credentials, or user identifiers are returned.
-- Statements are independent observations, not a synchronized snapshot.

SELECT statement_timestamp() AS observed_at, current_database() AS database_name,
       current_setting('transaction_read_only') AS transaction_read_only,
       n.nspname AS schema_name, c.relname AS table_name, c.relkind,
       c.relrowsecurity, c.relforcerowsecurity
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN (
  'agent_sessions', 'conversations', 'agent_runs', 'chat_threads', 'blobs',
  'pi_memory_stage1_candidates', 'pi_memory_stage1_selections'
)
ORDER BY c.relname;

-- External FKs into the two retired tables, plus the obsolete-column indexes.
SELECT c.conrelid::regclass::text AS source_table, c.conname AS constraint_name,
       c.confrelid::regclass::text AS target_table,
       pg_get_constraintdef(c.oid) AS definition
FROM pg_catalog.pg_constraint c
WHERE c.contype = 'f' AND c.confrelid IN (
  'public.agent_sessions'::regclass, 'public.conversations'::regclass
)
ORDER BY source_table, constraint_name;

WITH targets AS (
  SELECT c.oid, a.attnum
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
  WHERE n.nspname = 'public' AND NOT a.attisdropped AND (
    (c.relname = 'agent_runs' AND a.attname IN ('session_id', 'continued_from_session_id')) OR
    (c.relname = 'chat_threads' AND a.attname IN ('agent_session_id', 'agent_session_run_id'))
  )
)
SELECT DISTINCT pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid) AS dependency_object,
       d.deptype
FROM pg_catalog.pg_depend d
WHERE d.refclassid = 'pg_catalog.pg_class'::regclass AND (
  d.refobjid IN ('public.agent_sessions'::regclass, 'public.conversations'::regclass) OR
  EXISTS (SELECT 1 FROM targets t WHERE t.oid = d.refobjid AND t.attnum = d.refobjsubid)
)
ORDER BY dependency_object, deptype;

WITH routines AS (
  SELECT n.nspname AS schema_name, p.proname AS object_name,
         pg_get_function_identity_arguments(p.oid) AS identity_arguments,
         p.prokind, pg_get_functiondef(p.oid) AS definition
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
    AND p.prokind IN ('f', 'p')
)
SELECT schema_name, object_name, identity_arguments, prokind
FROM routines
WHERE definition ~* '\m(agent_sessions|conversations|agent_runs|chat_threads|continued_from_session_id|agent_session_id|agent_session_run_id)\M'
ORDER BY schema_name, object_name, identity_arguments;

WITH views AS (
  SELECT n.nspname AS schema_name, c.relname AS object_name, c.relkind,
         pg_get_viewdef(c.oid, true) AS definition
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('v', 'm')
    AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
)
SELECT schema_name, object_name, relkind
FROM views
WHERE definition ~* '\m(agent_sessions|conversations|agent_runs|chat_threads|continued_from_session_id|agent_session_id|agent_session_run_id)\M'
ORDER BY schema_name, object_name;

SELECT n.nspname AS schema_name, c.relname AS table_name, t.tgname AS trigger_name,
       pn.nspname AS function_schema, p.proname AS function_name
FROM pg_catalog.pg_trigger t
JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
JOIN pg_catalog.pg_namespace pn ON pn.oid = p.pronamespace
WHERE n.nspname = 'public' AND NOT t.tgisinternal
  AND c.relname IN ('agent_sessions', 'conversations', 'agent_runs', 'chat_threads')
ORDER BY table_name, trigger_name;

SELECT 'rule' AS object_kind, r.ev_class::regclass::text AS table_name, r.rulename AS object_name
FROM pg_catalog.pg_rewrite r
WHERE r.ev_class IN ('public.agent_sessions'::regclass, 'public.conversations'::regclass,
  'public.agent_runs'::regclass, 'public.chat_threads'::regclass)
UNION ALL
SELECT 'rls_policy', p.polrelid::regclass::text, p.polname
FROM pg_catalog.pg_policy p
WHERE p.polrelid IN ('public.agent_sessions'::regclass, 'public.conversations'::regclass,
  'public.agent_runs'::regclass, 'public.chat_threads'::regclass)
ORDER BY object_kind, table_name, object_name;

SELECT statement_timestamp() AS observed_at,
       pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') AS can_read_all_stats,
       count(*) FILTER (WHERE query IS NULL OR query = '<insufficient privilege>') AS invisible_other_sessions,
       count(*) FILTER (WHERE state = 'active' AND query ~* '\m(agent_sessions|conversations|continued_from_session_id|agent_session_id|agent_session_run_id)\M') AS active_retired_schema_queries
FROM pg_catalog.pg_stat_activity
WHERE datname = current_database() AND pid <> pg_backend_pid();

-- Memory's own source retain is distinct from Run's transferred archive retain.
SELECT source_format, status, count(*) AS candidate_count
FROM public.pi_memory_stage1_candidates GROUP BY source_format, status
ORDER BY source_format, status;
SELECT source_format, count(*) AS frozen_selection_count
FROM public.pi_memory_stage1_selections GROUP BY source_format ORDER BY source_format;

WITH run_refs AS MATERIALIZED (
  SELECT legacy_conversation_history_hash AS hash, count(*) AS refs
  FROM public.agent_runs WHERE legacy_conversation_history_hash IS NOT NULL
  GROUP BY legacy_conversation_history_hash
), memory_refs AS MATERIALIZED (
  SELECT source_history_hash AS hash, count(*) AS refs
  FROM public.pi_memory_stage1_candidates GROUP BY source_history_hash
), owners AS MATERIALIZED (
  SELECT coalesce(r.hash, m.hash) AS hash, coalesce(r.refs, 0) AS run_refs,
         coalesce(m.refs, 0) AS memory_refs
  FROM run_refs r FULL JOIN memory_refs m USING (hash)
), ledger AS MATERIALIZED (
  SELECT o.*, b.hash IS NULL AS missing_metadata, b.ref_count
  FROM owners o LEFT JOIN public.blobs b USING (hash)
)
SELECT statement_timestamp() AS observed_at,
       (SELECT count(*) FROM public.agent_runs WHERE legacy_conversation_history_hash IS NOT NULL) AS run_archive_retains,
       (SELECT count(*) FROM public.conversations) AS conversation_rows,
       (SELECT count(*) FROM public.conversations WHERE cli_agent_session_history IS NOT NULL) AS inline_history_rows,
       (SELECT count(*) FROM public.conversations WHERE cli_agent_session_history_hash IS NOT NULL) AS conversation_hash_mirrors,
       count(*) FILTER (WHERE run_refs > 0) AS run_archive_hashes,
       count(*) FILTER (WHERE memory_refs > 0) AS memory_source_hashes,
       count(*) FILTER (WHERE run_refs > 0 AND memory_refs > 0) AS shared_run_memory_hashes,
       count(*) FILTER (WHERE missing_metadata) AS missing_blob_metadata,
       count(*) FILTER (WHERE ref_count < run_refs + memory_refs) AS under_retained_hashes,
       count(*) FILTER (WHERE ref_count > run_refs + memory_refs) AS excess_retained_hashes,
       count(*) FILTER (WHERE ref_count < 0) AS negative_reference_counts
FROM ledger;

-- Late prepared private receipts are projected before retiring their readers.
SELECT count(*) AS legacy_private_output_receipts
FROM public.agent_runs r
WHERE r.chat_thread_id IS NULL AND r.framework = 'pi'
  AND r.status IN ('completed', 'failed', 'cancelled')
  AND r.framework_session_id = r.id::text
  AND r.legacy_conversation_history_hash IS NULL
  AND r.result ? 'agentSessionId' AND r.result ? 'conversationId'
  AND NOT (r.result ?| ARRAY['framework', 'frameworkSessionId']);
