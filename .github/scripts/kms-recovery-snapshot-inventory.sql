\set ON_ERROR_STOP on
\set VERBOSITY sqlstate
\set SHOW_CONTEXT never
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '120s';
SET LOCAL lock_timeout = '5s';
SET LOCAL row_security = off;

SELECT json_build_object(
  'kind', 'database',
  'readOnly', current_setting('transaction_read_only') = 'on',
  'isolation', current_setting('transaction_isolation'),
  'supportsTidRangeScan', current_setting('server_version_num')::int >= 140000,
  'plannedTables', (
    SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'm') AND n.nspname NOT LIKE 'pg\_%' ESCAPE '\'
      AND n.nspname <> 'information_schema'
  ),
  'largeObjects', (SELECT count(*) FROM pg_largeobject_metadata),
  'foreignTables', (
    SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'f' AND n.nspname NOT LIKE 'pg\_%' ESCAPE '\'
      AND n.nspname <> 'information_schema'
  )
);

-- Acquire ACCESS SHARE locks without returning rows, before measuring blocks.
-- This prevents truncation/rewrites while one read-only snapshot is scanned.
-- ONLY counts inherited tables separately, as with partition leaves.
SELECT format(
  'SELECT json_build_object(''kind'', ''scan-start'', ''phase'', ''table'',
    ''relationOid'', %s, ''relationBytes'', %s);
   SELECT 1 FROM ONLY %I.%I WHERE false;',
  c.oid, pg_table_size(c.oid), n.nspname, c.relname
)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'm') AND n.nspname NOT LIKE 'pg\_%' ESCAPE '\'
  AND n.nspname <> 'information_schema'
ORDER BY c.oid
\gexec

-- Scan at most 128 heap pages per statement; keep the 120s limit per chunk.
-- PostgreSQL 14+ uses a Tid Range Scan, avoiding a full rescan for each chunk.
-- The decoder requires each declared table's exact contiguous [0, blocks)
-- coverage before returning a table aggregate. Empty relations scan [0, 1).
WITH relations AS MATERIALIZED (
  SELECT c.oid, n.nspname, c.relname, pg_table_size(c.oid) AS bytes,
    c.relam = (SELECT oid FROM pg_am WHERE amname = 'heap') AS heap,
    greatest(1, (pg_relation_size(c.oid) + current_setting('block_size')::int - 1)
      / current_setting('block_size')::int) AS blocks
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'm') AND n.nspname NOT LIKE 'pg\_%' ESCAPE '\'
    AND n.nspname <> 'information_schema'
), commands AS (
  SELECT oid, -1::bigint AS first_block, format(
    'SELECT json_build_object(''kind'', ''table-plan'', ''relationOid'', %s,
      ''blocks'', %s, ''heapAccessMethod'', %L::boolean);', oid, blocks, heap
  ) AS command FROM relations
  UNION ALL
  SELECT oid, first_block, format(
    'SELECT json_build_object(''kind'', ''scan-start'', ''phase'', ''table'',
      ''relationOid'', %s, ''relationBytes'', %s, ''firstBlock'', %s, ''endBlock'', %s);
     SELECT json_build_object(''kind'', ''table-chunk'', ''relationOid'', %s,
      ''firstBlock'', %s, ''endBlock'', %s, ''rows'', count(*),
      ''rowsWithEnvelopeMarker'', count(*) FILTER (WHERE row_to_json(t)::text LIKE ''%%vm0secret:%%''),
      ''rowsWithSourceReference'', count(*) FILTER (WHERE row_to_json(t)::text LIKE ''%%a1b3922b-fab1-4ed3-aa9e-40f86f92a7a8%%''))
     FROM ONLY %I.%I t WHERE ctid >= %L::tid AND ctid < %L::tid;',
    oid, bytes, first_block, least(first_block + 128, blocks),
    oid, first_block, least(first_block + 128, blocks), nspname, relname,
    format('(%s,0)', first_block), format('(%s,0)', least(first_block + 128, blocks))
  ) FROM relations CROSS JOIN LATERAL generate_series(0, blocks - 1, 128) AS first_block
), batches AS (
-- Send at most 64 chunks together instead of waiting for a network round trip
-- per chunk. PostgreSQL 14+ applies statement_timeout to each statement in a
-- simple-query message; every chunk still emits its own progress and result.
-- Keep each table plan separate and before its contiguous chunk batches.
SELECT oid, min(first_block) AS first_block,
  string_agg(command, E'\n' ORDER BY first_block) AS command
FROM commands
GROUP BY oid, CASE WHEN first_block < 0 THEN -1 ELSE first_block / (128 * 64) END
)
-- A separate request exposes the batch being started before PostgreSQL buffers
-- results from its statements. The client line-flushes this aggregate marker.
SELECT command FROM (
  SELECT oid, first_block, 1 AS stage, command FROM batches
  UNION ALL
  SELECT b.oid, b.first_block, 0, format(
    'SELECT json_build_object(''kind'', ''batch-start'', ''relationOid'', %s,
      ''firstBlock'', %s, ''endBlock'', %s, ''startedAt'', clock_timestamp());',
    b.oid, b.first_block, least(b.first_block + 128 * 64, r.blocks)
  ) FROM batches b JOIN relations r USING (oid) WHERE b.first_block >= 0
) ordered_commands
ORDER BY oid, first_block, stage
\gexec

-- Binary values may hide encodings that row_to_json renders as hex. Their
-- presence is a coverage limitation, never evidence of key independence.
SELECT format(
  'SELECT json_build_object(''kind'', ''scan-start'', ''phase'', ''binary'',
    ''relationOid'', %s, ''relationBytes'', %s, ''columnNumber'', %s);
   SELECT json_build_object(''kind'', ''binary'', ''relationOid'', %s,
    ''columnNumber'', %s, ''nonNullValues'', count(%I)) FROM ONLY %I.%I;',
  c.oid, pg_table_size(c.oid), a.attnum, c.oid, a.attnum, a.attname, n.nspname, c.relname
)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid
JOIN pg_type ty ON ty.oid = a.atttypid
WHERE c.relkind IN ('r', 'm') AND n.nspname NOT LIKE 'pg\_%' ESCAPE '\'
  AND n.nspname <> 'information_schema' AND a.attnum > 0 AND NOT a.attisdropped
  AND (ty.oid = 'bytea'::regtype OR ty.typbasetype = 'bytea'::regtype
    OR ty.typelem = 'bytea'::regtype)
ORDER BY c.oid, a.attnum
\gexec
ROLLBACK;
