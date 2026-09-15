-- API 1.600.1 is the enforced canonical-only rollback floor. Migration 1132
-- shipped in API 1.603.1 before this contraction; retain its journal evidence.
-- Use the runner's unchanged 1s lock / 10s statement limits and one transaction.
LOCK TABLE public.org_plan_entitlements IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at >= 1789448024786
  ) THEN
    RAISE EXCEPTION 'Invitation column retirement requires migration 1132';
  END IF;

  IF (SELECT count(*) FROM pg_attribute a
      JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = 'public.org_plan_entitlements'::regclass
        AND a.attname IN ('member_invite_usage_pack_required', 'member_invitation_allowed')
        AND NOT a.attisdropped AND a.atttypid = 'boolean'::regtype AND a.attnotnull
        AND a.attgenerated = '' AND a.attidentity = ''
        AND pg_get_expr(d.adbin, d.adrelid) = 'false') <> 2 THEN
    RAISE EXCEPTION 'Invitation column retirement found unexpected column definitions';
  END IF;

  -- PL/pgSQL bodies can reference columns without a pg_depend entry. Inspect
  -- persisted routines as well as dependencies; historical source scans alone
  -- cannot prove the installed database is safe to contract.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND p.prokind IN ('f', 'p')
      AND p.prosrc ~* '\m(member_invite_usage_pack_required|member_invitation_allowed)\M'
  ) THEN
    RAISE EXCEPTION 'Invitation column retirement found a persisted SQL reference';
  END IF;

  -- DROP COLUMN can silently remove indexes/checks even with RESTRICT. Only
  -- these columns' own defaults and native NOT NULL constraints may disappear.
  IF EXISTS (
    SELECT 1 FROM pg_depend d JOIN pg_attribute a
      ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
    WHERE d.refclassid = 'pg_class'::regclass
      AND a.attrelid = 'public.org_plan_entitlements'::regclass
      AND a.attname IN ('member_invite_usage_pack_required', 'member_invitation_allowed')
      AND NOT (d.classid = 'pg_attrdef'::regclass AND d.objid IN (
        SELECT oid FROM pg_attrdef WHERE adrelid = a.attrelid AND adnum = a.attnum))
      AND NOT (d.classid = 'pg_constraint'::regclass AND d.objid IN (
        SELECT oid FROM pg_constraint WHERE conrelid = a.attrelid
          AND contype = 'n' AND conkey = ARRAY[a.attnum]))
  ) THEN
    RAISE EXCEPTION 'Invitation column retirement found an unexpected column dependency';
  END IF;
END;
$$;
--> statement-breakpoint
ALTER TABLE "org_plan_entitlements" DROP COLUMN "member_invite_usage_pack_required";
--> statement-breakpoint
ALTER TABLE "org_plan_entitlements" DROP COLUMN "member_invitation_allowed";
