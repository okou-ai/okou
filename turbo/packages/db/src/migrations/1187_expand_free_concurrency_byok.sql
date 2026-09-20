-- Refresh product-managed entitlement snapshots so existing workspaces receive
-- the same plan capabilities as new billing and onboarding writes. Preserve
-- manual entitlements because their limits are explicit operator overrides.
UPDATE "org_plan_entitlements"
SET
  "base_concurrency_limit" = CASE "plan_key"
    WHEN 'free' THEN 2
    WHEN 'limited-free-1' THEN 2
    WHEN 'pro' THEN 3
    ELSE "base_concurrency_limit"
  END,
  "support_byok" = CASE
    WHEN "plan_key" IN ('free', 'limited-free-1', 'pro', 'team', 'custom') THEN true
    ELSE "support_byok"
  END,
  "updated_at" = now()
WHERE "source" IN (
  'stripe_subscription',
  'stripe_atom_grant',
  'org_metadata_bootstrap',
  'org_metadata_migration'
)
AND (
  ("plan_key" IN ('free', 'limited-free-1') AND "base_concurrency_limit" IS DISTINCT FROM 2)
  OR ("plan_key" = 'pro' AND "base_concurrency_limit" IS DISTINCT FROM 3)
  OR (
    "plan_key" IN ('free', 'limited-free-1', 'pro', 'team', 'custom')
    AND "support_byok" IS DISTINCT FROM true
  )
);
