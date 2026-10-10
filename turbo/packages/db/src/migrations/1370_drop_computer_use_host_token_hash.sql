-- #38674 shipped the session-only mapping and rollback floor in API 1.725.1.
-- Take DROP's table lock before checking the catalog so tracked DDL cannot race
-- the census. RESTRICT alone silently removes local indexes and constraints.
LOCK TABLE "public"."computer_use_hosts" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  column_number smallint;
  retired_index oid;
  dependent_objects text;
BEGIN
  SELECT attnum INTO column_number
  FROM pg_catalog.pg_attribute
  WHERE attrelid = 'public.computer_use_hosts'::regclass
    AND attname = 'token_hash'
    AND NOT attisdropped;
  IF column_number IS NULL THEN
    RAISE EXCEPTION 'Expected computer_use_hosts.token_hash before retirement';
  END IF;

  retired_index := to_regclass('public.idx_computer_use_hosts_token_hash');
  IF retired_index IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index
    WHERE indexrelid = retired_index
      AND indrelid = 'public.computer_use_hosts'::regclass
      AND indisunique AND indisvalid
      AND indnatts = 1 AND indnkeyatts = 1 AND indkey[0] = column_number
      AND indexprs IS NULL AND indpred IS NULL
  ) THEN
    RAISE EXCEPTION 'Expected the single-column unique host token index before retirement';
  END IF;

  SELECT string_agg(object_name, ', ' ORDER BY object_name)
  INTO dependent_objects
  FROM (
    SELECT pg_catalog.pg_describe_object(classid, objid, objsubid) AS object_name
    FROM pg_catalog.pg_depend
    WHERE refclassid = 'pg_catalog.pg_class'::regclass
      AND refobjid = 'public.computer_use_hosts'::regclass
      AND refobjsubid = column_number
      AND NOT (classid = 'pg_catalog.pg_class'::regclass
        AND objid = retired_index AND objsubid = 0)
    UNION
    -- String-bodied routines can reference the column without pg_depend rows.
    SELECT format('routine %I.%I(%s)', namespace.nspname, routine.proname,
      pg_catalog.pg_get_function_identity_arguments(routine.oid))
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
      AND routine.prosrc ~* '\mcomputer_use_hosts\M'
      AND routine.prosrc ~* '\mtoken_hash\M'
  ) AS dependencies;
  IF dependent_objects IS NOT NULL THEN
    RAISE EXCEPTION 'Unexpected Computer Use host token dependencies: %', dependent_objects
      USING ERRCODE = '2BP01';
  END IF;

  IF EXISTS (SELECT 1 FROM public.computer_use_hosts WHERE token_hash IS NOT NULL) THEN
    RAISE EXCEPTION 'Host token hashes remain after retirement preparation';
  END IF;
  RAISE NOTICE 'Computer Use host token dependency census passed';
END;
$$;
--> statement-breakpoint
DROP INDEX "public"."idx_computer_use_hosts_token_hash";
--> statement-breakpoint
ALTER TABLE "public"."computer_use_hosts" DROP COLUMN "token_hash" RESTRICT;
