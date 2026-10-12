-- Preparation1380 must be independently serving, outgoing SQL drained and
-- compatible rollback enforced before this separately released contraction.
-- RESTRICT alone drops local indexes/checks and misses string-bodied routines.
LOCK TABLE "public"."ssh_connections" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  column_number smallint;
  row_type oid;
  dependent_objects text;
BEGIN
  SELECT attnum INTO column_number
  FROM pg_catalog.pg_attribute
  WHERE attrelid = 'public.ssh_connections'::regclass
    AND attname = 'needs_rebind' AND NOT attisdropped
    AND atttypid = 'boolean'::regtype AND attnotnull;
  IF column_number IS NULL THEN
    RAISE EXCEPTION 'Expected the prepared SSH needs_rebind boolean column';
  END IF;
  SELECT reltype INTO row_type FROM pg_catalog.pg_class
  WHERE oid = 'public.ssh_connections'::regclass;

  SELECT string_agg(object_name, ', ' ORDER BY object_name)
  INTO dependent_objects
  FROM (
    SELECT pg_catalog.pg_describe_object(classid, objid, objsubid) AS object_name
    FROM pg_catalog.pg_depend AS dependency
    WHERE refclassid = 'pg_catalog.pg_class'::regclass
      AND refobjid = 'public.ssh_connections'::regclass
      AND refobjsubid = column_number
      -- Only the prepared false default and ordinary NOT NULL metadata retire.
      AND NOT (
        classid = 'pg_catalog.pg_attrdef'::regclass
        AND EXISTS (
          SELECT 1 FROM pg_catalog.pg_attrdef
          WHERE oid = dependency.objid
            AND adrelid = 'public.ssh_connections'::regclass
            AND adnum = column_number
            AND pg_catalog.pg_get_expr(adbin, adrelid) = 'false'
        )
      )
      AND NOT (
        classid = 'pg_catalog.pg_constraint'::regclass
        AND EXISTS (
          SELECT 1 FROM pg_catalog.pg_constraint
          WHERE oid = dependency.objid
            AND conrelid = 'public.ssh_connections'::regclass
            AND contype = 'n' AND conkey = ARRAY[column_number]
        )
      )
    UNION
    SELECT pg_catalog.pg_describe_object(classid, objid, objsubid)
    FROM pg_catalog.pg_depend
    WHERE classid IN ('pg_catalog.pg_rewrite'::regclass, 'pg_catalog.pg_proc'::regclass)
      AND (
        (refclassid = 'pg_catalog.pg_class'::regclass
          AND refobjid = 'public.ssh_connections'::regclass AND refobjsubid = 0)
        OR (refclassid = 'pg_catalog.pg_type'::regclass AND refobjid = row_type)
      )
    UNION
    SELECT pg_catalog.pg_describe_object('pg_catalog.pg_proc'::regclass, routine.oid, 0)
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
      AND routine.prosrc ~* '\m(ssh_connections|needs_rebind)\M'
    UNION
    SELECT pg_catalog.pg_describe_object('pg_catalog.pg_trigger'::regclass, oid, 0)
    FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.ssh_connections'::regclass AND NOT tgisinternal
    UNION
    SELECT format('inheritance %s -> %s', inhparent::regclass, inhrelid::regclass)
    FROM pg_catalog.pg_inherits
    WHERE inhparent = 'public.ssh_connections'::regclass
      OR inhrelid = 'public.ssh_connections'::regclass
  ) AS dependencies;
  IF dependent_objects IS NOT NULL THEN
    RAISE EXCEPTION 'Unexpected SSH needs_rebind dependencies: %', dependent_objects
      USING ERRCODE = '2BP01';
  END IF;
END;
$$;
--> statement-breakpoint
ALTER TABLE "public"."ssh_connections" DROP COLUMN "needs_rebind" RESTRICT;
