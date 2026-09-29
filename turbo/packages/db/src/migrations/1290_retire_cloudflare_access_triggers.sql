-- Remove only the two prepared Cloudflare Access guards. This is catalog-only:
-- supported API writers validate the changed config and its affected bindings.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trg
    JOIN pg_catalog.pg_proc AS proc ON proc.oid = trg.tgfoid
    WHERE trg.tgrelid = '"public".ssh_connections'::regclass
      AND trg.tgname = 'ssh_cloudflare_access_binding_guard'
      AND trg.tgenabled = 'O'
      AND NOT trg.tgisinternal
      AND proc.oid = pg_catalog.to_regprocedure('"public".validate_ssh_cloudflare_access_binding()')
      AND pg_catalog.md5(proc.prosrc) = '78a8128b76b3379792960174c17b9bf1'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trg
    JOIN pg_catalog.pg_proc AS proc ON proc.oid = trg.tgfoid
    WHERE trg.tgrelid = '"public".cloudflare_access_configs'::regclass
      AND trg.tgname = 'cloudflare_access_scope_change_guard'
      AND trg.tgenabled = 'O'
      AND NOT trg.tgisinternal
      AND proc.oid = pg_catalog.to_regprocedure('"public".reject_cloudflare_access_scope_change()')
      AND pg_catalog.md5(proc.prosrc) = '9a32858723d6facc53fb33925484a8f3'
  ) THEN
    RAISE EXCEPTION 'Cloudflare Access legacy trigger catalog differs from the prepared schema';
  END IF;
END;
$$;
--> statement-breakpoint
DROP TRIGGER ssh_cloudflare_access_binding_guard ON "public".ssh_connections;
--> statement-breakpoint
DROP TRIGGER cloudflare_access_scope_change_guard ON "public".cloudflare_access_configs;
--> statement-breakpoint
DROP FUNCTION "public".validate_ssh_cloudflare_access_binding() RESTRICT;
--> statement-breakpoint
DROP FUNCTION "public".reject_cloudflare_access_scope_change() RESTRICT;
