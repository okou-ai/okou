-- #35240: preservation preflight observations, never a migration manifest.
-- Run the whole file in a fresh psql -X session with ON_ERROR_STOP=1.
-- Includes every status and deleted site; an unavailable relation fails the audit.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '3s';
SET LOCAL idle_in_transaction_session_timeout = '15s';
SET LOCAL work_mem = '16MB';
SET LOCAL max_parallel_workers_per_gather = 0;
SET LOCAL jit = off;
SET LOCAL row_security = off;
SET LOCAL timezone = 'UTC';
SET LOCAL search_path = pg_catalog, public;

WITH deployments AS MATERIALIZED (
  SELECT 'public' AS namespace, id, site_id, org_id, user_id, public_brand,
    status, (manifest->>'deploymentVersion')::integer AS deployment_version, manifest -> 'immutableContent' = 'true'::jsonb AS immutable
  FROM public.hosted_deployments
  UNION ALL
  SELECT 'private', id, site_id, org_id, user_id, public_brand,
    status, (manifest->>'deploymentVersion')::integer AS deployment_version, manifest -> 'immutableContent' = 'true'::jsonb
  FROM public.private_hosted_deployments
), site_populations AS MATERIALIZED (
  SELECT site_id, count(*) AS deployments,
    count(*) FILTER (WHERE namespace = 'public') AS public_deployments,
    count(*) FILTER (WHERE namespace = 'private') AS private_deployments,
    count(*) FILTER (WHERE status = 'ready') AS ready_deployments,
    count(DISTINCT deployment_version) AS numbered_versions
  FROM deployments GROUP BY site_id
), population AS (
  SELECT
    (SELECT count(*) FROM public.hosted_sites) AS sites,
    (SELECT count(*) FROM public.hosted_sites WHERE deleted_at IS NOT NULL) AS deleted_sites,
    (SELECT count(*) FROM public.hosted_sites s WHERE NOT EXISTS (
      SELECT 1 FROM site_populations p WHERE p.site_id = s.id)) AS sites_without_deployments,
    count(*) AS deployments,
    count(*) FILTER (WHERE namespace = 'public') AS public_deployments,
    count(*) FILTER (WHERE namespace = 'private') AS private_deployments,
    count(*) FILTER (WHERE status = 'ready') AS ready_deployments,
    count(*) FILTER (WHERE status = 'uploading') AS uploading_deployments,
    count(*) FILTER (WHERE status = 'failed') AS failed_deployments,
    count(*) FILTER (WHERE status = 'deleted') AS deleted_deployments,
    count(*) FILTER (WHERE status NOT IN ('ready', 'uploading', 'failed', 'deleted')) AS unknown_status_deployments,
    count(*) FILTER (WHERE deployment_version IS NULL) AS null_version_deployments,
    count(*) FILTER (WHERE deployment_version = 1) AS version_one_deployments,
    count(*) FILTER (WHERE deployment_version > 1) AS later_version_deployments,
    count(*) FILTER (WHERE deployment_version <= 0) AS nonpositive_version_deployments,
    count(*) FILTER (WHERE immutable IS TRUE) AS marked_immutable_deployments,
    count(*) FILTER (WHERE immutable IS NOT TRUE) AS unmarked_deployments
  FROM deployments
), multiplicity AS (
  SELECT count(*) FILTER (WHERE deployments > 1) AS multiple_deployment_sites,
    coalesce(sum(deployments) FILTER (WHERE deployments > 1), 0) AS deployments_in_multiple_deployment_sites,
    count(*) FILTER (WHERE ready_deployments > 1) AS multiple_ready_deployment_sites,
    count(*) FILTER (WHERE numbered_versions > 1) AS multiple_numbered_version_sites,
    count(*) FILTER (WHERE public_deployments > 0 AND private_deployments > 0) AS mixed_namespace_sites,
    coalesce(max(deployments), 0) AS maximum_deployments_per_site,
    (SELECT count(*) FROM (SELECT id FROM deployments GROUP BY id HAVING count(*) > 1) d) AS duplicate_deployment_ids,
    (SELECT count(*) FROM (SELECT site_id, deployment_version FROM deployments
      WHERE deployment_version IS NOT NULL GROUP BY site_id, deployment_version
      HAVING count(*) > 1) d) AS duplicate_site_version_pairs
  FROM site_populations
), deployment_integrity AS (
  SELECT count(*) FILTER (WHERE s.id IS NULL) AS missing_sites,
    count(*) FILTER (WHERE s.deleted_at IS NOT NULL) AS deployments_on_deleted_sites,
    count(*) FILTER (WHERE s.id IS NOT NULL AND d.org_id IS DISTINCT FROM s.org_id) AS org_mismatches,
    count(*) FILTER (WHERE s.id IS NOT NULL AND d.user_id IS DISTINCT FROM s.user_id) AS user_mismatches,
    count(*) FILTER (WHERE s.id IS NOT NULL AND d.public_brand IS DISTINCT FROM s.public_brand) AS brand_mismatches
  FROM deployments d LEFT JOIN public.hosted_sites s ON s.id = d.site_id
), pointers AS MATERIALIZED (
  SELECT s.id, s.active_deployment_id,
    count(d.id) AS matches,
    bool_or(d.site_id IS DISTINCT FROM s.id) AS different_site,
    bool_or(d.org_id IS DISTINCT FROM s.org_id OR d.user_id IS DISTINCT FROM s.user_id) AS different_owner,
    bool_or(d.public_brand IS DISTINCT FROM s.public_brand) AS different_brand,
    bool_or(d.status <> 'ready') AS not_ready,
    bool_or(d.namespace = 'private') AS private_target
  FROM public.hosted_sites s LEFT JOIN deployments d ON d.id = s.active_deployment_id
  GROUP BY s.id
), pointer_integrity AS (
  SELECT count(*) FILTER (WHERE active_deployment_id IS NULL) AS absent_pointers,
    count(*) FILTER (WHERE active_deployment_id IS NOT NULL AND matches = 0) AS missing_targets,
    count(*) FILTER (WHERE matches > 1) AS ambiguous_targets,
    count(*) FILTER (WHERE matches > 0 AND different_site) AS different_site_targets,
    count(*) FILTER (WHERE matches > 0 AND different_owner) AS different_owner_targets,
    count(*) FILTER (WHERE matches > 0 AND different_brand) AS different_brand_targets,
    count(*) FILTER (WHERE matches > 0 AND not_ready) AS not_ready_targets,
    count(*) FILTER (WHERE matches > 0 AND private_target) AS private_targets
  FROM pointers
), shares AS (
  SELECT count(*) AS html_share_rows,
    count(*) FILTER (WHERE s.id IS NULL) AS missing_site_targets,
    count(*) FILTER (WHERE s.deleted_at IS NOT NULL) AS deleted_site_targets,
    count(*) FILTER (WHERE s.id IS NOT NULL AND a.org_id IS DISTINCT FROM s.org_id) AS org_mismatches,
    count(*) FILTER (WHERE s.id IS NOT NULL AND a.user_id IS DISTINCT FROM s.user_id) AS user_mismatches,
    count(*) FILTER (WHERE s.id IS NOT NULL AND a.public_brand IS DISTINCT FROM s.public_brand) AS brand_mismatches
  FROM public.artifact_shares a LEFT JOIN public.hosted_sites s ON s.id = a.target_id
  WHERE a.target_kind = 'html'
), uploaded_references AS MATERIALIZED (
  -- Compare text without casting untrusted historical JSON to UUID.
  SELECT f.id, f.metadata ->> 'deploymentId' AS deployment_id,
    f.metadata ->> 'siteId' AS site_id, count(d.id) AS matches,
    bool_or(d.site_id::text IS DISTINCT FROM f.metadata ->> 'siteId') AS different_site,
    bool_or(d.org_id IS DISTINCT FROM f.org_id OR d.user_id IS DISTINCT FROM f.user_id) AS different_owner
  FROM public.run_uploaded_files f LEFT JOIN deployments d
    ON d.id::text = f.metadata ->> 'deploymentId'
  WHERE f.metadata ->> 'generatedBy' = 'zero-official-website'
    OR f.metadata ->> 'artifactKind' IN ('hosted-site', 'presentation-html')
    OR f.metadata ? 'deploymentId'
  GROUP BY f.id
), uploaded_integrity AS (
  SELECT count(*) AS hosted_reference_rows,
    count(*) FILTER (WHERE deployment_id IS NULL) AS absent_deployment_references,
    count(*) FILTER (WHERE deployment_id IS NOT NULL AND matches = 0) AS missing_deployment_targets,
    count(*) FILTER (WHERE matches > 1) AS ambiguous_deployment_targets,
    count(*) FILTER (WHERE site_id IS NULL) AS absent_site_references,
    count(*) FILTER (WHERE matches > 0 AND different_site) AS different_site_targets,
    count(*) FILTER (WHERE matches > 0 AND different_owner) AS different_owner_targets
  FROM uploaded_references
)
SELECT jsonb_build_object(
  'receipt_version', 'hosted_publication_history_v2',
  'observed_at', statement_timestamp(),
  'finished_at', clock_timestamp(),
  'transaction', jsonb_build_object(
    'read_only', current_setting('transaction_read_only'),
    'isolation', current_setting('transaction_isolation'),
    'ending', 'rollback',
    'statement_timeout', current_setting('statement_timeout'),
    'lock_timeout', current_setting('lock_timeout')),
  'coverage', jsonb_build_object(
    'all_deployment_statuses', true, 'deleted_sites_included', true,
    'r2_objects_and_aliases_verified', false, 'share_policies_verified', false,
    'catalog_and_chat_references_verified', false, 'serving_and_rollback_writers_verified', false,
    'authorizes_migration_or_deletion', false),
  'population', to_jsonb(p), 'multiplicity', to_jsonb(m),
  'deployment_integrity', to_jsonb(d), 'pointer_integrity', to_jsonb(i),
  'shares', to_jsonb(s), 'uploaded_references', to_jsonb(u)
) AS hosted_publication_history_audit
FROM population p CROSS JOIN multiplicity m CROSS JOIN deployment_integrity d
  CROSS JOIN pointer_integrity i CROSS JOIN shares s CROSS JOIN uploaded_integrity u;
ROLLBACK;
