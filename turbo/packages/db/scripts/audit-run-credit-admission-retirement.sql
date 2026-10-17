-- Read-only preflight for #40886; run against the actual production database.
-- psql --no-psqlrc --set ON_ERROR_STOP=1 --dbname "$DATABASE_URL" --file scripts/audit-run-credit-admission-retirement.sql
-- These statements are independent read-only observations. The migration
-- repeats this census under its DDL lock; this receipt alone
-- does not prove API drain, enforce rollback floors or authorize contraction.
SET statement_timeout = '10s';

SELECT attribute.attname AS column_name,
  pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS column_type,
  attribute.attnotnull AS not_null,
  pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid) AS default_value
FROM pg_catalog.pg_attribute AS attribute
LEFT JOIN pg_catalog.pg_attrdef AS default_value
  ON default_value.adrelid = attribute.attrelid
  AND default_value.adnum = attribute.attnum
WHERE attribute.attrelid = 'public.agent_runs'::regclass
  AND attribute.attname = 'credit_admitted' AND NOT attribute.attisdropped;

WITH retired AS (
  SELECT attnum FROM pg_catalog.pg_attribute
  WHERE attrelid = 'public.agent_runs'::regclass
    AND attname = 'credit_admitted' AND NOT attisdropped
), row_types AS (
  SELECT relation.reltype AS row_type, row.typarray AS row_array_type
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_type AS row ON row.oid = relation.reltype
  WHERE relation.oid = 'public.agent_runs'::regclass
)
SELECT object_name AS unexpected_dependency
FROM (
    SELECT pg_catalog.pg_describe_object(classid, objid, objsubid) AS object_name
    FROM pg_catalog.pg_depend AS dependency
    WHERE refclassid = 'pg_catalog.pg_class'::regclass
      AND refobjid = 'public.agent_runs'::regclass
      AND refobjsubid = (SELECT attnum FROM retired)
      -- Only the prepared false default and ordinary NOT NULL metadata retire.
      AND NOT (
        classid = 'pg_catalog.pg_attrdef'::regclass
        AND EXISTS (
          SELECT 1 FROM pg_catalog.pg_attrdef
          WHERE oid = dependency.objid
            AND adrelid = 'public.agent_runs'::regclass
            AND adnum = (SELECT attnum FROM retired)
            AND pg_catalog.pg_get_expr(adbin, adrelid) = 'false'
        )
      )
      AND NOT (
        classid = 'pg_catalog.pg_constraint'::regclass
        AND EXISTS (
          SELECT 1 FROM pg_catalog.pg_constraint
          WHERE oid = dependency.objid
            AND conrelid = 'public.agent_runs'::regclass
            AND contype = 'n' AND conkey = ARRAY[(SELECT attnum FROM retired)]
        )
      )
    UNION
    SELECT pg_catalog.pg_describe_object(classid, objid, objsubid)
    FROM pg_catalog.pg_depend
    WHERE classid IN ('pg_catalog.pg_rewrite'::regclass, 'pg_catalog.pg_proc'::regclass)
      AND refclassid = 'pg_catalog.pg_class'::regclass
      AND refobjid = 'public.agent_runs'::regclass AND refobjsubid = 0
    UNION
    -- Composite columns, domains and array consumers can silently survive DROP
    -- with a changed row shape. Only the table's own array metadata is expected.
    SELECT pg_catalog.pg_describe_object(classid, objid, objsubid)
    FROM pg_catalog.pg_depend
    WHERE refclassid = 'pg_catalog.pg_type'::regclass
      AND refobjid IN ((SELECT row_type FROM row_types), (SELECT row_array_type FROM row_types))
      AND NOT (
        classid = 'pg_catalog.pg_type'::regclass AND objid = (SELECT row_array_type FROM row_types)
        AND refobjid = (SELECT row_type FROM row_types) AND deptype = 'i'
      )
    UNION
    SELECT pg_catalog.pg_describe_object('pg_catalog.pg_proc'::regclass, routine.oid, 0)
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
      AND routine.prosrc ~* '\m(agent_runs|credit_admitted)\M'
    UNION
    SELECT pg_catalog.pg_describe_object('pg_catalog.pg_trigger'::regclass, oid, 0)
    FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.agent_runs'::regclass AND NOT tgisinternal
    UNION
    SELECT format('inheritance %s -> %s', inhparent::regclass, inhrelid::regclass)
    FROM pg_catalog.pg_inherits
    WHERE inhparent = 'public.agent_runs'::regclass
      OR inhrelid = 'public.agent_runs'::regclass
) AS dependencies
ORDER BY object_name;
