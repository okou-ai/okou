-- The organization default model is fixed to the built-in "okou-1.0" (Auto)
-- policy and is no longer configurable. Every organization gets that policy
-- with the built-in workspace route, and it becomes the only is_default row
-- so API instances that still read the flag during the rollout agree with
-- the new API, which only writes it. model_mode and member preferences stay.
--
-- The default flag moves first because of
-- idx_org_model_policies_one_default_per_org. An older API instance can still
-- seed a default between statements; such an organization keeps that flag
-- instead of failing the migration, which the new API does not read.
UPDATE org_model_policies
SET is_default = false, updated_at = now()
WHERE is_default AND model <> 'okou-1.0';
--> statement-breakpoint
-- okou-1.0 supports only the built-in route; normalize any stored variant.
UPDATE org_model_policies AS policy
SET
  is_default = NOT EXISTS (
    SELECT 1
    FROM org_model_policies AS other
    WHERE other.org_id = policy.org_id
      AND other.is_default
      AND other.model <> 'okou-1.0'
  ),
  default_provider_type = 'built-in',
  credential_scope = 'org',
  model_provider_id = NULL,
  model_provider_surface_id = NULL,
  updated_at = now()
WHERE policy.model = 'okou-1.0'
  AND (
    NOT policy.is_default
    OR policy.default_provider_type <> 'built-in'
    OR policy.credential_scope <> 'org'
    OR policy.model_provider_id IS NOT NULL
    OR policy.model_provider_surface_id IS NOT NULL
  );
--> statement-breakpoint
-- The creator columns are nullable; a system-created policy has no user.
INSERT INTO org_model_policies (
  org_id,
  model,
  is_default,
  default_provider_type,
  credential_scope,
  model_provider_id,
  model_provider_surface_id,
  created_by_user_id,
  updated_by_user_id,
  created_at,
  updated_at
)
SELECT
  orgs.org_id,
  'okou-1.0',
  NOT EXISTS (
    SELECT 1
    FROM org_model_policies AS other
    WHERE other.org_id = orgs.org_id AND other.is_default
  ),
  'built-in',
  'org',
  NULL,
  NULL,
  NULL,
  NULL,
  now(),
  now()
FROM (
  SELECT org_id FROM org_metadata
  UNION
  SELECT org_id FROM org_model_policies
) AS orgs
ON CONFLICT (org_id, model) DO NOTHING;
