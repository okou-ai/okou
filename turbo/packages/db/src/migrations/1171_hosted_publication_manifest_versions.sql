-- #35240 phase A: retire relational version fields from application statements.
-- Preserve every deployment and storage identity. Keep old columns until the
-- preceding API has drained and the phase-A API is the supported rollback floor.
LOCK TABLE public.hosted_sites, public.hosted_deployments, public.private_hosted_deployments IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.hosted_sites s
    LEFT JOIN public.hosted_deployments d ON d.id = s.active_deployment_id
    WHERE (s.active_deployment_id IS NULL AND s.active_deployment_version IS NOT NULL)
      OR (s.active_deployment_id IS NOT NULL AND (
        d.id IS NULL
        OR d.site_id IS DISTINCT FROM s.id
        OR d.org_id IS DISTINCT FROM s.org_id
        OR d.public_brand IS DISTINCT FROM s.public_brand
        OR d.deployment_version IS DISTINCT FROM s.active_deployment_version
      ))
  ) THEN
    RAISE EXCEPTION 'Hosted publication version retirement found an inconsistent public alias';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.hosted_deployments WHERE jsonb_typeof(manifest) <> 'object'
    UNION ALL
    SELECT 1 FROM public.private_hosted_deployments WHERE jsonb_typeof(manifest) <> 'object'
  ) THEN
    RAISE EXCEPTION 'Hosted publication version retirement requires object manifests';
  END IF;
END;
$$;
--> statement-breakpoint
WITH normalized AS (
  SELECT id, CASE
    WHEN deployment_version IS NULL THEN manifest - 'deploymentVersion'
    ELSE jsonb_set(manifest, '{deploymentVersion}', to_jsonb(deployment_version))
  END AS manifest
  FROM public.hosted_deployments
)
UPDATE public.hosted_deployments d
SET manifest = n.manifest,
    manifest_hash = encode(sha256(convert_to(n.manifest::text, 'UTF8')), 'hex')
FROM normalized n
WHERE d.id = n.id AND d.manifest::text IS DISTINCT FROM n.manifest::text;
--> statement-breakpoint
WITH normalized AS (
  SELECT id, jsonb_set(manifest, '{deploymentVersion}', to_jsonb(deployment_version)) AS manifest
  FROM public.private_hosted_deployments
)
UPDATE public.private_hosted_deployments d
SET manifest = n.manifest,
    manifest_hash = encode(sha256(convert_to(n.manifest::text, 'UTF8')), 'hex')
FROM normalized n
WHERE d.id = n.id AND d.manifest::text IS DISTINCT FROM n.manifest::text;
--> statement-breakpoint
-- The application derives active versions through active_deployment_id. Mirror
-- that pointer for outgoing API readers; phase B drops this trigger and column.
CREATE FUNCTION public.mirror_hosted_site_active_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.active_deployment_id IS NULL THEN
    NEW.active_deployment_version := NULL;
  ELSE
    SELECT deployment_version INTO STRICT NEW.active_deployment_version
    FROM public.hosted_deployments
    WHERE id = NEW.active_deployment_id
      AND site_id = NEW.id
      AND org_id = NEW.org_id
      AND public_brand = NEW.public_brand;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER mirror_hosted_site_active_version
BEFORE UPDATE OF active_deployment_id ON public.hosted_sites
FOR EACH ROW EXECUTE FUNCTION public.mirror_hosted_site_active_version();
