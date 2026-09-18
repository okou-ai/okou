-- #35240 phase B. Release only after the phase-A API is serving, older APIs
-- have drained, and every supported rollback target omits these columns.
-- A merged preparation PR or a committed migration alone does not satisfy that
-- deployment gate. Preserve all content rows, identities, manifests and shares.
LOCK TABLE public.hosted_sites, public.hosted_deployments, public.private_hosted_deployments IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at >= 1789734203175
  ) THEN
    RAISE EXCEPTION 'Hosted publication column retirement requires phase-A migration 1168';
  END IF;

  IF (SELECT count(*) FROM pg_attribute a
      WHERE NOT a.attisdropped AND a.atttypid = 'integer'::regtype
        AND a.attgenerated = '' AND a.attidentity = ''
        AND (a.attrelid, a.attname, a.attnotnull) IN (
          ('public.hosted_sites'::regclass, 'active_deployment_version', false),
          ('public.hosted_sites'::regclass, 'next_deployment_version', true),
          ('public.hosted_deployments'::regclass, 'deployment_version', false),
          ('public.private_hosted_deployments'::regclass, 'deployment_version', true)
        )) <> 4 THEN
    RAISE EXCEPTION 'Hosted publication column retirement found unexpected column definitions';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.hosted_deployments d
    WHERE d.deployment_version::text IS DISTINCT FROM d.manifest->>'deploymentVersion'
      OR (d.deployment_version IS NULL AND d.manifest ? 'deploymentVersion')
      OR (d.deployment_version IS NOT NULL AND jsonb_typeof(d.manifest->'deploymentVersion') IS DISTINCT FROM 'number')
    UNION ALL
    SELECT 1 FROM public.private_hosted_deployments d
    WHERE d.deployment_version::text IS DISTINCT FROM d.manifest->>'deploymentVersion'
      OR jsonb_typeof(d.manifest->'deploymentVersion') IS DISTINCT FROM 'number'
  ) THEN
    RAISE EXCEPTION 'Hosted publication column retirement found an unpreserved version mapping';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.hosted_sites s
    LEFT JOIN public.hosted_deployments d ON d.id = s.active_deployment_id
    WHERE (s.active_deployment_id IS NULL AND s.active_deployment_version IS NOT NULL)
      OR (s.active_deployment_id IS NOT NULL AND (
        d.id IS NULL OR d.site_id IS DISTINCT FROM s.id
        OR d.org_id IS DISTINCT FROM s.org_id
        OR d.public_brand IS DISTINCT FROM s.public_brand
        OR d.deployment_version IS DISTINCT FROM s.active_deployment_version
      ))
  ) THEN
    RAISE EXCEPTION 'Hosted publication column retirement found an inconsistent public alias';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = to_regprocedure('public.mirror_hosted_site_active_version()')
      AND md5(prosrc) = 'a59eea5918c16453c35e349862d6059d'
  ) THEN
    RAISE EXCEPTION 'Hosted publication column retirement found an unexpected mirror function';
  END IF;

  -- PL/pgSQL bodies may reference columns without a recorded pg_depend edge.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND p.prokind IN ('f', 'p')
      AND p.oid <> 'public.mirror_hosted_site_active_version()'::regprocedure
      AND p.prosrc ~* '\m(active_deployment_version|next_deployment_version|deployment_version)\M'
  ) THEN
    RAISE EXCEPTION 'Hosted publication column retirement found a persisted SQL reference';
  END IF;

  -- DROP COLUMN can silently remove indexes/checks even without CASCADE. Only
  -- the two retired indexes, column defaults and native NOT NULL may disappear.
  IF EXISTS (
    SELECT 1 FROM pg_depend d JOIN pg_attribute a
      ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
    WHERE d.refclassid = 'pg_class'::regclass
      AND (a.attrelid, a.attname) IN (
        ('public.hosted_sites'::regclass, 'active_deployment_version'),
        ('public.hosted_sites'::regclass, 'next_deployment_version'),
        ('public.hosted_deployments'::regclass, 'deployment_version'),
        ('public.private_hosted_deployments'::regclass, 'deployment_version')
      )
      AND NOT (d.classid = 'pg_attrdef'::regclass AND d.objid IN (
        SELECT oid FROM pg_attrdef WHERE adrelid = a.attrelid AND adnum = a.attnum))
      AND NOT (d.classid = 'pg_constraint'::regclass AND d.objid IN (
        SELECT oid FROM pg_constraint WHERE conrelid = a.attrelid
          AND contype = 'n' AND conkey = ARRAY[a.attnum]))
      AND NOT (d.classid = 'pg_class'::regclass AND d.objid IN (
        'public.idx_hosted_deployments_site_version'::regclass,
        'public.idx_private_hosted_deployments_site_version'::regclass))
  ) THEN
    RAISE EXCEPTION 'Hosted publication column retirement found an unexpected column dependency';
  END IF;
END;
$$;
--> statement-breakpoint
DROP TRIGGER mirror_hosted_site_active_version ON public.hosted_sites;
--> statement-breakpoint
DROP FUNCTION public.mirror_hosted_site_active_version();
--> statement-breakpoint
DROP INDEX "idx_hosted_deployments_site_version";--> statement-breakpoint
DROP INDEX "idx_private_hosted_deployments_site_version";--> statement-breakpoint
ALTER TABLE "hosted_deployments" DROP COLUMN "deployment_version";--> statement-breakpoint
ALTER TABLE "hosted_sites" DROP COLUMN "active_deployment_version";--> statement-breakpoint
ALTER TABLE "hosted_sites" DROP COLUMN "next_deployment_version";--> statement-breakpoint
ALTER TABLE "private_hosted_deployments" DROP COLUMN "deployment_version";