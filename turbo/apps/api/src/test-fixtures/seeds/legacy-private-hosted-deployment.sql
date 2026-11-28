-- Fixed API test baseline for historical private_hosted_deployments isolation
-- tests. Production no longer creates private_hosted_deployments rows, so a
-- deterministic historical snapshot paired with a live public site is seeded
-- under a dedicated seed owner/org that no generated test user shares.
INSERT INTO hosted_sites (
  id,
  org_id,
  user_id,
  slug,
  requested_slug,
  link_layout_segment,
  public_slug,
  active_deployment_id,
  show_banner,
  created_at,
  updated_at
)
VALUES (
  '00000000-0000-4000-8000-000000009001',
  'org_legacy_private_hosted_seed',
  'user_legacy_private_hosted_seed',
  'legacy-isolated-site',
  'legacy-isolated-site',
  'okou',
  'legacy-isolated-site-seed',
  '00000000-0000-4000-8000-000000009002',
  true,
  '2026-01-01T00:00:00.000Z',
  '2026-01-01T00:00:00.000Z'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO hosted_deployments (
  id,
  site_id,
  org_id,
  user_id,
  link_layout_segment,
  status,
  r2_prefix,
  manifest,
  manifest_hash,
  content_hash,
  entrypoint,
  spa_fallback,
  file_count,
  size_bytes,
  url,
  created_at,
  updated_at,
  ready_at
)
VALUES (
  '00000000-0000-4000-8000-000000009002',
  '00000000-0000-4000-8000-000000009001',
  'org_legacy_private_hosted_seed',
  'user_legacy_private_hosted_seed',
  'okou',
  'ready',
  'sites/brands/okou/publications/00000000-0000-4000-8000-000000009002',
  '{"version":1,"publicBrand":"okou","deploymentId":"00000000-0000-4000-8000-000000009002","siteId":"00000000-0000-4000-8000-000000009001","publicSlug":"legacy-isolated-site-seed","deploymentVersion":2,"visibility":"public","createdAt":"2026-01-01T00:00:00.000Z","spaFallback":false,"files":{}}'::jsonb,
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  '/index.html',
  false,
  0,
  0,
  'https://legacy-isolated-site-seed.okou.app/',
  '2026-01-01T00:00:00.000Z',
  '2026-01-01T00:00:00.000Z',
  '2026-01-01T00:00:00.000Z'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO private_hosted_deployments (
  id,
  site_id,
  org_id,
  user_id,
  link_layout_segment,
  status,
  artifact_url,
  r2_prefix,
  manifest,
  manifest_hash,
  content_hash,
  entrypoint,
  spa_fallback,
  file_count,
  size_bytes,
  url,
  created_at,
  updated_at,
  ready_at
)
VALUES (
  '00000000-0000-4000-8000-000000009003',
  '00000000-0000-4000-8000-000000009001',
  'org_legacy_private_hosted_seed',
  'user_legacy_private_hosted_seed',
  'okou',
  'ready',
  '/artifacts/00000000-0000-4000-8000-000000009003.html',
  'private-sites/00000000-0000-4000-8000-000000009003',
  '{"version":1,"access":"owner-private-v1","publicBrand":"okou","deploymentId":"00000000-0000-4000-8000-000000009003","siteId":"00000000-0000-4000-8000-000000009001","publicSlug":"legacy-isolated-site-seed","deploymentVersion":1,"createdAt":"2026-01-01T00:00:00.000Z","spaFallback":false,"files":{}}'::jsonb,
  'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  '/index.html',
  false,
  0,
  0,
  'https://legacy-isolated-site-seed.okou.app/',
  '2026-01-01T00:00:00.000Z',
  '2026-01-01T00:00:00.000Z',
  '2026-01-01T00:00:00.000Z'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO artifacts (
  id,
  org_id,
  author_user_id,
  kind,
  entity_id,
  logical_key,
  source_url,
  projection_created_at,
  title,
  visibility,
  category,
  created_at,
  updated_at
)
VALUES (
  '00000000-0000-4000-8000-000000009004',
  'org_legacy_private_hosted_seed',
  'user_legacy_private_hosted_seed',
  'hosted-site',
  '00000000-0000-4000-8000-000000009001',
  'site:00000000-0000-4000-8000-000000009001',
  'https://legacy-isolated-site-seed.okou.app/',
  '2026-01-01T00:00:00.000Z',
  'Legacy Isolated Live Site',
  'public',
  'website',
  '2026-01-01T00:00:00.000Z',
  '2026-01-01T00:00:00.000Z'
)
ON CONFLICT (id) DO NOTHING;
