-- #41808 removed this column from the runtime mapping; that preparation is
-- serving and every supported rollback target contains it.
-- RESTRICT alone drops local indexes/checks and misses string-bodied routines.
LOCK TABLE "public"."runner_state" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  column_number smallint;
  row_type oid;
  row_array_type oid;
  dependent_objects text;
BEGIN
  SELECT attnum INTO column_number
  FROM pg_catalog.pg_attribute
  WHERE attrelid = 'public.runner_state'::regclass
    AND attname = 'wss_ingress_service_active' AND NOT attisdropped
    AND atttypid = 'boolean'::regtype AND attnotnull;
  IF column_number IS NULL THEN
    RAISE EXCEPTION 'Expected the retired runner_state wss_ingress_service_active boolean column';
  END IF;
  SELECT relation.reltype, row.typarray INTO row_type, row_array_type
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_type AS row ON row.oid = relation.reltype
  WHERE relation.oid = 'public.runner_state'::regclass;

  SELECT string_agg(object_name, ', ' ORDER BY object_name)
  INTO dependent_objects
  FROM (
    SELECT pg_catalog.pg_describe_object(classid, objid, objsubid) AS object_name
    FROM pg_catalog.pg_depend AS dependency
    WHERE refclassid = 'pg_catalog.pg_class'::regclass
      AND refobjid = 'public.runner_state'::regclass
      AND refobjsubid = column_number
      -- Only the false default and ordinary NOT NULL metadata retire.
      AND NOT (
        classid = 'pg_catalog.pg_attrdef'::regclass
        AND EXISTS (
          SELECT 1 FROM pg_catalog.pg_attrdef
          WHERE oid = dependency.objid
            AND adrelid = 'public.runner_state'::regclass
            AND adnum = column_number
            AND pg_catalog.pg_get_expr(adbin, adrelid) = 'false'
        )
      )
      AND NOT (
        classid = 'pg_catalog.pg_constraint'::regclass
        AND EXISTS (
          SELECT 1 FROM pg_catalog.pg_constraint
          WHERE oid = dependency.objid
            AND conrelid = 'public.runner_state'::regclass
            AND contype = 'n' AND conkey = ARRAY[column_number]
        )
      )
    UNION
    SELECT pg_catalog.pg_describe_object(classid, objid, objsubid)
    FROM pg_catalog.pg_depend
    WHERE classid IN ('pg_catalog.pg_rewrite'::regclass, 'pg_catalog.pg_proc'::regclass)
      AND refclassid = 'pg_catalog.pg_class'::regclass
      AND refobjid = 'public.runner_state'::regclass AND refobjsubid = 0
    UNION
    -- Composite columns, domains and array consumers can silently survive DROP
    -- with a changed row shape. Only the table's own array metadata is expected.
    SELECT pg_catalog.pg_describe_object(classid, objid, objsubid)
    FROM pg_catalog.pg_depend
    WHERE refclassid = 'pg_catalog.pg_type'::regclass
      AND refobjid IN (row_type, row_array_type)
      AND NOT (
        classid = 'pg_catalog.pg_type'::regclass AND objid = row_array_type
        AND refobjid = row_type AND deptype = 'i'
      )
    UNION
    SELECT pg_catalog.pg_describe_object('pg_catalog.pg_proc'::regclass, routine.oid, 0)
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
      AND routine.prosrc ~* '\m(runner_state|wss_ingress_service_active)\M'
    UNION
    SELECT pg_catalog.pg_describe_object('pg_catalog.pg_trigger'::regclass, oid, 0)
    FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.runner_state'::regclass AND NOT tgisinternal
    UNION
    SELECT format('inheritance %s -> %s', inhparent::regclass, inhrelid::regclass)
    FROM pg_catalog.pg_inherits
    WHERE inhparent = 'public.runner_state'::regclass
      OR inhrelid = 'public.runner_state'::regclass
  ) AS dependencies;
  IF dependent_objects IS NOT NULL THEN
    RAISE EXCEPTION 'Unexpected runner_state wss_ingress_service_active dependencies: %', dependent_objects
      USING ERRCODE = '2BP01';
  END IF;
END;
$$;
--> statement-breakpoint
ALTER TABLE "public"."runner_state" DROP COLUMN "wss_ingress_service_active" RESTRICT;
