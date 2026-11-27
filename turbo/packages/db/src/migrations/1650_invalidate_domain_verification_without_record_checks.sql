-- Discard unverifiable results but keep verified_at, which reserves the hostname.
WITH invalidated AS (
  UPDATE hosted_site_domains
  SET verification = NULL, revision = gen_random_uuid()
  WHERE released_at IS NULL
    AND jsonb_typeof(verification) = 'object'
    AND NOT (verification ? 'recordChecks')
  RETURNING id, site_id
)
UPDATE hosted_site_domain_settings AS settings
SET selected_domain_id = CASE
      WHEN settings.selected_domain_id IN (SELECT id FROM invalidated) THEN NULL
      ELSE settings.selected_domain_id
    END,
    -- Fence in-flight saves on affected sites, including selects of a stale domain.
    revision = gen_random_uuid()
WHERE settings.site_id IN (SELECT site_id FROM invalidated);
