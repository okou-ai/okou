-- #41808 removed every WSS ticket reader and writer; that preparation is
-- serving and every supported API rollback target contains it. Tickets had a
-- 30-second TTL and were deleted on redemption, so only expired digests remain.
LOCK TABLE "public"."runner_wss_tickets" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  dependent_objects text;
BEGIN
  -- RESTRICT silently removes table-owned objects. Allow only the original
  -- PK, outbound FK, two indexes, timestamp default and PostgreSQL-owned
  -- row/TOAST types. Also inspect string-bodied routines, which may have no
  -- dependency edges.
  SELECT string_agg(object_name, ', ' ORDER BY object_name)
  INTO dependent_objects
  FROM (
    SELECT pg_catalog.pg_describe_object(dependency.classid, dependency.objid, dependency.objsubid) AS object_name
    FROM pg_catalog.pg_depend AS dependency
    CROSS JOIN pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_type AS row_type ON row_type.oid = relation.reltype
    WHERE relation.oid = 'public.runner_wss_tickets'::regclass
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
        OR (dependency.classid = 'pg_catalog.pg_class'::regclass AND dependency.deptype = 'a'
          AND pg_catalog.pg_get_indexdef(dependency.objid) IN (
            'CREATE INDEX runner_wss_tickets_run_created_idx ON public.runner_wss_tickets USING btree (run_id, created_at)',
            'CREATE INDEX runner_wss_tickets_created_idx ON public.runner_wss_tickets USING btree (created_at)'
          ))
        OR (dependency.classid = 'pg_catalog.pg_constraint'::regclass AND EXISTS (
          SELECT 1 FROM pg_catalog.pg_constraint AS constraint_row
          WHERE constraint_row.oid = dependency.objid AND constraint_row.conrelid = relation.oid
            AND (
              (constraint_row.conname = 'runner_wss_tickets_pkey'
                AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) = 'PRIMARY KEY (digest)')
              OR (constraint_row.conname = 'runner_wss_tickets_run_id_agent_runs_id_fk'
                AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) = 'FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE')
              -- PostgreSQL 18 records ordinary NOT NULLs in pg_constraint.
              OR (constraint_row.contype = 'n'
                AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) IN (
                  'NOT NULL digest', 'NOT NULL run_id', 'NOT NULL org_id', 'NOT NULL user_id',
                  'NOT NULL runner_id', 'NOT NULL origin', 'NOT NULL created_at'
                ))
            )
        ))
        OR (dependency.classid = 'pg_catalog.pg_attrdef'::regclass AND EXISTS (
          SELECT 1 FROM pg_catalog.pg_attrdef AS default_row
          JOIN pg_catalog.pg_attribute AS attribute
            ON attribute.attrelid = default_row.adrelid AND attribute.attnum = default_row.adnum
          WHERE default_row.oid = dependency.objid AND default_row.adrelid = relation.oid
            AND attribute.attname = 'created_at'
            AND pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid) = 'now()'
        ))
      )
    UNION
    SELECT pg_catalog.pg_describe_object('pg_catalog.pg_proc'::regclass, routine.oid, 0)
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
      AND routine.prosrc ~* '\mrunner_wss_tickets\M'
    UNION
    SELECT pg_catalog.pg_describe_object('pg_catalog.pg_trigger'::regclass, oid, 0)
    FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.runner_wss_tickets'::regclass
      AND NOT tgisinternal
    UNION
    SELECT format('inheritance %s -> %s', inhparent::regclass, inhrelid::regclass)
    FROM pg_catalog.pg_inherits
    WHERE inhparent = 'public.runner_wss_tickets'::regclass
      OR inhrelid = 'public.runner_wss_tickets'::regclass
  ) AS dependencies;
  IF dependent_objects IS NOT NULL THEN
    RAISE EXCEPTION 'Unexpected Runner WSS ticket dependencies: %', dependent_objects
      USING ERRCODE = '2BP01';
  END IF;
END;
$$;
--> statement-breakpoint
-- Never cascade into another consumer. Failure preserves data and the journal.
DROP TABLE "public"."runner_wss_tickets" RESTRICT;
