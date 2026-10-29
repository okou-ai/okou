-- #43797 removed both retired preferences from the runtime mapping; that
-- preparation is serving and every supported rollback target contains it.
-- RESTRICT alone drops local indexes/checks and misses string-bodied routines.
LOCK TABLE "public"."org_members_metadata" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  planning_column smallint;
  translation_column smallint;
  row_type oid;
  row_array_type oid;
  dependent_objects text;
BEGIN
  SELECT attnum INTO planning_column
  FROM pg_catalog.pg_attribute
  WHERE attrelid = 'public.org_members_metadata'::regclass
    AND attname = 'proactive_planning_enabled' AND NOT attisdropped
    AND atttypid = 'boolean'::regtype AND NOT attnotnull AND NOT atthasdef;
  IF planning_column IS NULL THEN
    RAISE EXCEPTION 'Expected the retired nullable proactive_planning_enabled boolean column';
  END IF;
  SELECT attnum INTO translation_column
  FROM pg_catalog.pg_attribute
  WHERE attrelid = 'public.org_members_metadata'::regclass
    AND attname = 'translation_language' AND NOT attisdropped
    AND atttypid = 'text'::regtype AND NOT attnotnull AND NOT atthasdef;
  IF translation_column IS NULL THEN
    RAISE EXCEPTION 'Expected the retired nullable translation_language text column';
  END IF;
  SELECT relation.reltype, row.typarray INTO row_type, row_array_type
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_type AS row ON row.oid = relation.reltype
  WHERE relation.oid = 'public.org_members_metadata'::regclass;

  SELECT string_agg(object_name, ', ' ORDER BY object_name)
  INTO dependent_objects
  FROM (
    -- Both columns are nullable without defaults, so nothing may depend on them.
    SELECT pg_catalog.pg_describe_object(classid, objid, objsubid) AS object_name
    FROM pg_catalog.pg_depend
    WHERE refclassid = 'pg_catalog.pg_class'::regclass
      AND refobjid = 'public.org_members_metadata'::regclass
      AND refobjsubid IN (planning_column, translation_column)
    UNION
    SELECT pg_catalog.pg_describe_object(classid, objid, objsubid)
    FROM pg_catalog.pg_depend
    WHERE classid IN ('pg_catalog.pg_rewrite'::regclass, 'pg_catalog.pg_proc'::regclass)
      AND refclassid = 'pg_catalog.pg_class'::regclass
      AND refobjid = 'public.org_members_metadata'::regclass AND refobjsubid = 0
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
      AND routine.prosrc ~* '\m(org_members_metadata|proactive_planning_enabled|translation_language)\M'
    UNION
    SELECT pg_catalog.pg_describe_object('pg_catalog.pg_trigger'::regclass, oid, 0)
    FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.org_members_metadata'::regclass AND NOT tgisinternal
    UNION
    SELECT format('inheritance %s -> %s', inhparent::regclass, inhrelid::regclass)
    FROM pg_catalog.pg_inherits
    WHERE inhparent = 'public.org_members_metadata'::regclass
      OR inhrelid = 'public.org_members_metadata'::regclass
  ) AS dependencies;
  IF dependent_objects IS NOT NULL THEN
    RAISE EXCEPTION 'Unexpected retired member preference dependencies: %', dependent_objects
      USING ERRCODE = '2BP01';
  END IF;
END;
$$;
--> statement-breakpoint
ALTER TABLE "public"."org_members_metadata" DROP COLUMN "proactive_planning_enabled" RESTRICT;
--> statement-breakpoint
ALTER TABLE "public"."org_members_metadata" DROP COLUMN "translation_language" RESTRICT;
