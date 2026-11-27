-- Continue confirmed DNS setups from the browser-driven verifier. Old checks
-- keep their original deadline, including those that have already timed out.
WITH adopted AS (
  UPDATE hosted_site_domains AS domain
  SET verification = jsonb_set(domain.verification, '{automatic}', jsonb_build_object(
    'id', gen_random_uuid(),
    'expiresAt', to_char(
      ((domain.verification->>'checkedAt')::timestamptz + interval '30 minutes') AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'status', CASE WHEN (domain.verification->>'checkedAt')::timestamptz + interval '30 minutes' > now()
      THEN 'checking' ELSE 'timed_out' END
  ))
  FROM hosted_sites AS site
  WHERE site.id = domain.site_id AND site.deleted_at IS NULL
    AND domain.revoked_at IS NULL AND domain.released_at IS NULL
    AND NOT (domain.verification ? 'automatic')
    AND domain.verification @> '{"status":"incomplete","checks":{"ownership":{"status":"passed"},"dns":{"status":"passed"}}}'
    AND NOT jsonb_path_exists(domain.verification, '$.checks.* ? (@.status == "failed" || @.status == "unavailable")')
    AND NOT jsonb_path_exists(domain.verification, '$.recordChecks[*] ? (@.status != "passed")')
  RETURNING domain.id, domain.site_id, domain.revision, domain.verification->'automatic' AS automatic,
    site.user_id, site.org_id
)
INSERT INTO background_jobs (id, kind, handler_version, user_id, org_id, input)
SELECT (automatic->>'id')::uuid, 'hosted-domain-verification', 1, user_id, org_id,
  jsonb_build_object('siteId', site_id, 'domainId', id, 'expectedRevision', revision)
FROM adopted WHERE automatic->>'status' = 'checking';
