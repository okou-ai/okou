-- Function bodies stored as strings are not covered by PostgreSQL's table
-- dependency tracking. Reject them and unexpected user triggers before DROP.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.desktop_auth_handoff_codes'::regclass
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'Unexpected trigger on desktop_auth_handoff_codes';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname !~ '^pg_'
      AND namespace.nspname <> 'information_schema'
      AND routine.prosrc ILIKE '%desktop_auth_handoff_codes%'
  ) THEN
    RAISE EXCEPTION 'Unexpected function reference to desktop_auth_handoff_codes';
  END IF;
END
$$;--> statement-breakpoint
DROP TABLE "desktop_auth_handoff_codes";
