-- #39185 must be independently promoted and outgoing SQL drained before DROP.
-- Hold DROP's locks during the census; RESTRICT alone silently removes local
-- column indexes/checks and cannot find references in string-bodied routines.
LOCK TABLE "public"."pi_memory_phase2_jobs", "public"."pi_memory_phase2_checkpoints" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  column_numbers smallint[];
  job_row_type oid;
  dependent_objects text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.pi_memory_phase2_jobs
    WHERE status = 'leased'
      AND (legacy_lease_token = lease_token OR sandbox_lease_token = lease_token)
  ) THEN
    RAISE EXCEPTION 'Pi memory compatibility leases remain before contraction';
  END IF;

  SELECT array_agg(attnum ORDER BY attname) INTO column_numbers
  FROM pg_catalog.pg_attribute
  WHERE attrelid = 'public.pi_memory_phase2_jobs'::regclass
    AND attname IN ('legacy_lease_token', 'sandbox_lease_token', 'last_maintenance_checkpoint_version_id')
    AND NOT attisdropped;
  IF cardinality(column_numbers) IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'Expected all three Pi memory compatibility columns';
  END IF;
  SELECT reltype INTO job_row_type FROM pg_catalog.pg_class
  WHERE oid = 'public.pi_memory_phase2_jobs'::regclass;

  SELECT string_agg(object_name, ', ' ORDER BY object_name)
  INTO dependent_objects
  FROM (
    SELECT pg_catalog.pg_describe_object(classid, objid, objsubid) AS object_name
    FROM pg_catalog.pg_depend
    WHERE refclassid = 'pg_catalog.pg_class'::regclass
      AND refobjid = 'public.pi_memory_phase2_jobs'::regclass
      AND refobjsubid = ANY(column_numbers)
    UNION
    SELECT pg_catalog.pg_describe_object(classid, objid, objsubid)
    FROM pg_catalog.pg_depend
    WHERE classid IN ('pg_catalog.pg_rewrite'::regclass, 'pg_catalog.pg_proc'::regclass)
      AND (
        (refclassid = 'pg_catalog.pg_class'::regclass
          AND refobjid = 'public.pi_memory_phase2_jobs'::regclass
          AND refobjsubid = 0)
        OR (refclassid = 'pg_catalog.pg_type'::regclass AND refobjid = job_row_type)
      )
    UNION
    SELECT pg_catalog.pg_describe_object('pg_catalog.pg_constraint'::regclass, oid, 0)
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.pi_memory_phase2_checkpoints'::regclass
      -- PostgreSQL 18 represents the table's ordinary NOT NULLs as constraints.
      AND contype <> 'n'
      AND conname NOT IN ('pi_memory_phase2_checkpoints_pkey',
        'pi_memory_phase2_checkpoints_run_id_agent_runs_id_fk',
        'pi_memory_phase2_checkpoints_storage_owner_fk',
        'pi_memory_phase2_checkpoints_identity_check')
    UNION
    SELECT pg_catalog.pg_describe_object('pg_catalog.pg_class'::regclass, indexrelid, 0)
    FROM pg_catalog.pg_index
    WHERE indrelid = 'public.pi_memory_phase2_checkpoints'::regclass AND NOT indisprimary
    UNION
    SELECT pg_catalog.pg_describe_object('pg_catalog.pg_trigger'::regclass, oid, 0)
    FROM pg_catalog.pg_trigger
    WHERE tgrelid IN ('public.pi_memory_phase2_jobs'::regclass,
      'public.pi_memory_phase2_checkpoints'::regclass) AND NOT tgisinternal
    UNION
    SELECT format('inheritance %s -> %s', inhparent::regclass, inhrelid::regclass)
    FROM pg_catalog.pg_inherits
    WHERE inhparent IN ('public.pi_memory_phase2_jobs'::regclass,
      'public.pi_memory_phase2_checkpoints'::regclass)
      OR inhrelid IN ('public.pi_memory_phase2_jobs'::regclass,
        'public.pi_memory_phase2_checkpoints'::regclass)
    UNION
    SELECT pg_catalog.pg_describe_object('pg_catalog.pg_proc'::regclass, routine.oid, 0)
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
      AND routine.prosrc ~* '\m(pi_memory_phase2_checkpoints|legacy_lease_token|sandbox_lease_token|last_maintenance_checkpoint_version_id)\M'
  ) AS dependencies;
  IF dependent_objects IS NOT NULL THEN
    RAISE EXCEPTION 'Unexpected Pi memory storage dependencies: %', dependent_objects
      USING ERRCODE = '2BP01';
  END IF;
END;
$$;
--> statement-breakpoint
DROP TABLE "public"."pi_memory_phase2_checkpoints" RESTRICT;
--> statement-breakpoint
ALTER TABLE "public"."pi_memory_phase2_jobs"
  DROP COLUMN "legacy_lease_token" RESTRICT,
  DROP COLUMN "sandbox_lease_token" RESTRICT,
  DROP COLUMN "last_maintenance_checkpoint_version_id" RESTRICT;
