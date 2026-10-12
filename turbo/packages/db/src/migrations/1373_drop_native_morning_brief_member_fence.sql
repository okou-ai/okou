-- #38737 removed every runtime column projection and shipped before contraction.
-- Acquire DROP's lock before the census so tracked DDL cannot race it.
LOCK TABLE "public"."org_members_metadata" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  column_number smallint;
  row_type oid;
  dependent_objects text;
BEGIN
  SELECT attribute.attnum, relation.reltype INTO column_number, row_type
  FROM pg_catalog.pg_attribute AS attribute
  JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
  WHERE attribute.attrelid = 'public.org_members_metadata'::regclass
    AND attribute.attname = 'morning_brief_collection_revoked_at'
    AND NOT attribute.attisdropped;
  IF column_number IS NULL THEN
    RAISE EXCEPTION 'Expected org_members_metadata.morning_brief_collection_revoked_at before retirement';
  END IF;

  SELECT string_agg(object_name, ', ' ORDER BY object_name)
  INTO dependent_objects
  FROM (
    -- Includes local indexes and constraints that RESTRICT silently removes.
    SELECT pg_catalog.pg_describe_object(classid, objid, objsubid) AS object_name
    FROM pg_catalog.pg_depend
    WHERE refclassid = 'pg_catalog.pg_class'::regclass
      AND refobjid = 'public.org_members_metadata'::regclass
      AND refobjsubid = column_number
    UNION
    -- Whole-row views and routines can depend on the table or composite type.
    SELECT pg_catalog.pg_describe_object(classid, objid, objsubid)
    FROM pg_catalog.pg_depend
    WHERE classid IN ('pg_catalog.pg_rewrite'::regclass, 'pg_catalog.pg_proc'::regclass)
      AND (
        (refclassid = 'pg_catalog.pg_class'::regclass
          AND refobjid = 'public.org_members_metadata'::regclass
          AND refobjsubid = 0)
        OR (refclassid = 'pg_catalog.pg_type'::regclass AND refobjid = row_type)
      )
    UNION
    -- String-bodied routines, including NEW.column trigger code, may be untracked.
    SELECT pg_catalog.pg_describe_object('pg_catalog.pg_proc'::regclass, routine.oid, 0)
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
      AND (
        strpos(lower(routine.prosrc), 'morning_brief_collection_revoked_at') > 0
        OR strpos(lower(routine.prosrc), 'org_members_metadata') > 0
      )
    UNION
    SELECT pg_catalog.pg_describe_object('pg_catalog.pg_trigger'::regclass, oid, 0)
    FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.org_members_metadata'::regclass AND NOT tgisinternal
  ) AS dependencies;
  IF dependent_objects IS NOT NULL THEN
    RAISE EXCEPTION 'Unexpected Native Morning Brief member fence dependencies: %', dependent_objects
      USING ERRCODE = '2BP01';
  END IF;
  RAISE NOTICE 'Native Morning Brief member fence dependency census passed';
END;
$$;
--> statement-breakpoint
ALTER TABLE "public"."org_members_metadata" DROP COLUMN "morning_brief_collection_revoked_at" RESTRICT;
