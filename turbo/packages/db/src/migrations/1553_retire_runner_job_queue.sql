-- #47138 must already serve and its outgoing reader-capable API requests must
-- finish draining before this separate contraction. Never discard queued Runs.
LOCK TABLE "public"."runner_job_queue" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  dependent_objects text;
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."runner_job_queue") THEN
    RAISE EXCEPTION 'Cannot retire runner_job_queue while queued Runs remain'
      USING ERRCODE = '23514';
  END IF;

  -- RESTRICT does not reject every table-owned object or string-bodied routine.
  -- Allow only the queue's original keys, indexes, defaults and internal types.
  SELECT string_agg(object_name, ', ' ORDER BY object_name)
  INTO dependent_objects
  FROM (
    SELECT pg_catalog.pg_describe_object(dependency.classid, dependency.objid, dependency.objsubid) AS object_name
    FROM pg_catalog.pg_depend AS dependency
    CROSS JOIN pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_type AS row_type ON row_type.oid = relation.reltype
    WHERE relation.oid = 'public.runner_job_queue'::regclass
      AND (
        (dependency.refclassid = 'pg_catalog.pg_class'::regclass AND dependency.refobjid = relation.oid)
        OR (dependency.refclassid = 'pg_catalog.pg_type'::regclass
          AND dependency.refobjid IN (relation.reltype, row_type.typarray))
      )
      AND NOT (
        (dependency.classid = 'pg_catalog.pg_type'::regclass AND dependency.deptype = 'i'
          AND dependency.objid = relation.reltype AND dependency.refclassid = 'pg_catalog.pg_class'::regclass)
        OR (dependency.classid = 'pg_catalog.pg_type'::regclass AND dependency.deptype = 'i'
          AND dependency.objid = row_type.typarray AND dependency.refobjid = relation.reltype)
        OR (dependency.classid = 'pg_catalog.pg_class'::regclass AND dependency.deptype = 'i'
          AND dependency.objid = relation.reltoastrelid AND dependency.refclassid = 'pg_catalog.pg_class'::regclass)
        OR (dependency.classid = 'pg_catalog.pg_constraint'::regclass AND EXISTS (
          SELECT 1 FROM pg_catalog.pg_constraint AS constraint_row
          WHERE constraint_row.oid = dependency.objid AND constraint_row.conrelid = relation.oid
            AND (
              (constraint_row.conname = 'runner_job_queue_pkey'
                AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) = 'PRIMARY KEY (run_id)')
              OR (constraint_row.conname = 'runner_job_queue_run_id_agent_runs_id_fk'
                AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) = 'FOREIGN KEY (run_id) REFERENCES agent_runs(id)')
              -- PostgreSQL 18 records ordinary NOT NULLs in pg_constraint.
              OR (constraint_row.contype = 'n'
                AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) IN (
                  'NOT NULL run_id', 'NOT NULL runner_group', 'NOT NULL profile',
                  'NOT NULL execution_context', 'NOT NULL created_at', 'NOT NULL expires_at'
                ))
            )
        ))
        OR (dependency.classid = 'pg_catalog.pg_class'::regclass AND EXISTS (
          SELECT 1 FROM pg_catalog.pg_index AS index_row
          WHERE index_row.indexrelid = dependency.objid AND index_row.indrelid = relation.oid
            AND pg_catalog.pg_get_indexdef(index_row.indexrelid, 0, true) IN (
              'CREATE INDEX runner_job_queue_expires_at_idx ON runner_job_queue USING btree (expires_at)',
              'CREATE INDEX runner_job_queue_group_profile_idx ON runner_job_queue USING btree (runner_group, profile)'
            )
        ))
        OR (dependency.classid = 'pg_catalog.pg_attrdef'::regclass AND EXISTS (
          SELECT 1 FROM pg_catalog.pg_attrdef AS default_row
          JOIN pg_catalog.pg_attribute AS attribute
            ON attribute.attrelid = default_row.adrelid AND attribute.attnum = default_row.adnum
          WHERE default_row.oid = dependency.objid AND default_row.adrelid = relation.oid
            AND (
              (attribute.attname = 'created_at'
                AND pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid) = 'now()')
              OR (attribute.attname = 'profile'
                AND pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid) = '''vm0/default''::character varying')
            )
        ))
      )
    UNION
    SELECT pg_catalog.pg_describe_object('pg_catalog.pg_proc'::regclass, routine.oid, 0)
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
      AND routine.prosrc ~* '\mrunner_job_queue\M'
    UNION
    SELECT pg_catalog.pg_describe_object('pg_catalog.pg_trigger'::regclass, oid, 0)
    FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.runner_job_queue'::regclass AND NOT tgisinternal
    UNION
    SELECT format('inheritance %s -> %s', inhparent::regclass, inhrelid::regclass)
    FROM pg_catalog.pg_inherits
    WHERE inhparent = 'public.runner_job_queue'::regclass
      OR inhrelid = 'public.runner_job_queue'::regclass
  ) AS dependencies;
  IF dependent_objects IS NOT NULL THEN
    RAISE EXCEPTION 'Unexpected Runner queue dependencies: %', dependent_objects
      USING ERRCODE = '2BP01';
  END IF;
END;
$$;
--> statement-breakpoint
DROP TABLE "public"."runner_job_queue" RESTRICT;
