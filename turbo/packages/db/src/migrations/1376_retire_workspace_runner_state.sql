-- Requires the preceding column-independent application release and SQL drain.
-- Take DROP's table lock before its census: RESTRICT can still remove local
-- indexes/checks, and inherited columns can propagate to another table.
LOCK TABLE "public"."runner_state" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  column_numbers smallint[];
  workspace_column smallint;
  dependent_objects text;
BEGIN
  SELECT array_agg(attnum ORDER BY attname) INTO column_numbers
  FROM pg_catalog.pg_attribute
  WHERE attrelid = 'public.runner_state'::regclass
    AND attname IN ('held_workspace_states', 'home_affinity_version',
      'home_affinity_generation', 'home_affinity_sequence')
    AND NOT attisdropped;
  IF cardinality(column_numbers) IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'Expected all four Runner state retirement columns';
  END IF;
  SELECT attnum INTO workspace_column FROM pg_catalog.pg_attribute
  WHERE attrelid = 'public.runner_state'::regclass
    AND attname = 'held_workspace_states' AND NOT attisdropped;

  SELECT string_agg(object_name, ', ' ORDER BY object_name)
  INTO dependent_objects
  FROM (
    SELECT pg_catalog.pg_describe_object(classid, objid, objsubid) AS object_name
    FROM pg_catalog.pg_depend AS dependency
    WHERE refclassid = 'pg_catalog.pg_class'::regclass
      AND refobjid = 'public.runner_state'::regclass
      AND refobjsubid = ANY(column_numbers)
      AND NOT (
        classid = 'pg_catalog.pg_attrdef'::regclass AND EXISTS (
          SELECT 1 FROM pg_catalog.pg_attrdef AS definition
          WHERE definition.oid = dependency.objid
            AND definition.adrelid = 'public.runner_state'::regclass
            AND definition.adnum = dependency.refobjsubid
        )
      )
      AND NOT (
        classid = 'pg_catalog.pg_constraint'::regclass AND EXISTS (
          SELECT 1 FROM pg_catalog.pg_constraint AS constraint_record
          WHERE constraint_record.oid = dependency.objid
            AND constraint_record.conrelid = 'public.runner_state'::regclass
            AND constraint_record.contype = 'n'
            AND constraint_record.conkey = ARRAY[workspace_column]
        )
      )
    UNION
    SELECT format('inherited table %s', inhrelid::regclass)
    FROM pg_catalog.pg_inherits
    WHERE inhparent = 'public.runner_state'::regclass
    UNION
    -- String-bodied routines may have no column-level pg_depend record.
    SELECT format('routine %I.%I(%s)', namespace.nspname, routine.proname,
      pg_catalog.pg_get_function_identity_arguments(routine.oid))
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
      AND routine.prosrc ~* '\mrunner_state\M'
      AND routine.prosrc ~* '\m(held_workspace_states|home_affinity_version|home_affinity_generation|home_affinity_sequence)\M'
  ) AS dependencies;
  IF dependent_objects IS NOT NULL THEN
    RAISE EXCEPTION 'Unexpected Runner state retirement dependencies: %', dependent_objects
      USING ERRCODE = '2BP01';
  END IF;
END;
$$;
--> statement-breakpoint
ALTER TABLE "public"."runner_state"
  DROP COLUMN "held_workspace_states" RESTRICT,
  DROP COLUMN "home_affinity_version" RESTRICT,
  DROP COLUMN "home_affinity_generation" RESTRICT,
  DROP COLUMN "home_affinity_sequence" RESTRICT;
