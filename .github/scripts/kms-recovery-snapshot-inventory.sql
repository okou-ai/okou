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
  'largeObjects', (SELECT count(*) FROM pg_largeobject_metadata),
  'foreignTables', (
    SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'f' AND n.nspname NOT LIKE 'pg\_%' ESCAPE '\'
      AND n.nspname <> 'information_schema'
  )
);

-- Scan physical tables, including partition leaves, and materialized views.
-- Identifiers are quoted by PostgreSQL; gexec executes SQL, not psql commands.
-- Only aggregates leave the database. No rows, ciphertext or primary keys do.
SELECT format(
  'SELECT json_build_object(''kind'', ''scan-start'', ''phase'', ''table'',
    ''relationOid'', %s, ''relationBytes'', %s);
   SELECT json_build_object(''kind'', ''table'', ''relationOid'', %s,
    ''rows'', count(*),
    ''rowsWithEnvelopeMarker'', count(*) FILTER (WHERE row_to_json(t)::text LIKE ''%%vm0secret:%%''),
    ''rowsWithSourceReference'', count(*) FILTER (WHERE row_to_json(t)::text LIKE ''%%a1b3922b-fab1-4ed3-aa9e-40f86f92a7a8%%''))
   FROM %I.%I t;', c.oid, pg_table_size(c.oid), c.oid, n.nspname, c.relname
)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'm') AND n.nspname NOT LIKE 'pg\_%' ESCAPE '\'
  AND n.nspname <> 'information_schema'
ORDER BY c.oid
\gexec

-- Binary values may hide encodings that row_to_json renders as hex. Their
-- presence is a coverage limitation, never evidence of key independence.
SELECT format(
  'SELECT json_build_object(''kind'', ''scan-start'', ''phase'', ''binary'',
    ''relationOid'', %s, ''relationBytes'', %s, ''columnNumber'', %s);
   SELECT json_build_object(''kind'', ''binary'', ''relationOid'', %s,
    ''columnNumber'', %s, ''nonNullValues'', count(%I)) FROM %I.%I;',
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
