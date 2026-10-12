-- #38431 removed every runtime SQL reference before this later contraction.
-- Check the actual database before DROP: RESTRICT alone would silently remove
-- local indexes/constraints, and string-bodied functions may lack pg_depend rows.
-- Acquire DROP's table lock before the census so tracked DDL cannot race it.
LOCK TABLE "public"."chat_threads" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  column_number smallint;
  dependent_objects text;
BEGIN
  SELECT attnum INTO column_number
  FROM pg_catalog.pg_attribute
  WHERE attrelid = 'public.chat_threads'::regclass
    AND attname = 'provenance'
    AND NOT attisdropped;
  IF column_number IS NULL THEN
    RAISE EXCEPTION 'Expected chat_threads.provenance before retirement';
  END IF;

  SELECT string_agg(object_name, ', ' ORDER BY object_name)
  INTO dependent_objects
  FROM (
    SELECT pg_catalog.pg_describe_object(classid, objid, objsubid) AS object_name
    FROM pg_catalog.pg_depend
    WHERE refclassid = 'pg_catalog.pg_class'::regclass
      AND refobjid = 'public.chat_threads'::regclass
      AND refobjsubid = column_number
    UNION
    SELECT format('routine %I.%I(%s)', namespace.nspname, routine.proname,
      pg_catalog.pg_get_function_identity_arguments(routine.oid))
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
      AND routine.prosrc ~* '\mchat_threads\M'
      AND routine.prosrc ~* '\mprovenance\M'
  ) AS dependencies;
  IF dependent_objects IS NOT NULL THEN
    RAISE EXCEPTION 'Unexpected chat thread provenance dependencies: %', dependent_objects
      USING ERRCODE = '2BP01';
  END IF;
  RAISE NOTICE 'Chat thread provenance dependency census passed';
END;
$$;
--> statement-breakpoint
ALTER TABLE "public"."chat_threads" DROP COLUMN "provenance" RESTRICT;
