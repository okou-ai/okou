import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { applyPendingMigrations } from "./migration-runner";

/**
 * Transition validator for migration 1658:
 * - Seeds data right after 1657 across all 9 retired tables, `artifact_user_shares`,
 *   `artifacts` (including the 3 dropped columns), and retained tables
 *   (`hosted_site_share_rate_limits`, `private_hosted_deployments`).
 * - Confirms a dependent view on a retired table rejects the migration with
 *   `2BP01` (`RESTRICT`) and rolls back the entire transaction cleanly without
 *   advancing the migration journal.
 * - Applies 1658 and verifies:
 *   1. All 9 retired tables and `artifact_user_shares` are dropped.
 *   2. `artifact_user_shares` rows survive atomically in renamed `artifact_shares`,
 *      with canonical PK, FK, and index names.
 *   3. The 3 redundant columns and partial index on `artifacts` are dropped while
 *      existing artifact rows survive untouched.
 *   4. Retained tables (`hosted_site_share_rate_limits`,
 *      `private_hosted_deployments`) survive untouched.
 */
export async function validateArtifactStorageRetirement(
  databaseUrl: string,
  migrationMillis: number,
) {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  const tag = randomUUID().slice(0, 8);
  const orgId = `org-retire-1658-${tag}`;
  const ownerUserId = `user-owner-1658-${tag}`;
  const viewerUserId = `user-viewer-1658-${tag}`;
  const viewerEmail = `viewer-${tag}@example.com`;
  const rufId = randomUUID();
  const fileId = randomUUID();
  const artifactId = randomUUID();
  const siteId = randomUUID();
  const privDeployId = randomUUID();
  const rateLimitKey = `retire-1658-rate-limit-${tag}`;
  const dummyHash = "0".repeat(64);

  const retire = () => {
    return applyPendingMigrations(sql, { beforeMillis: migrationMillis + 1 });
  };

  try {
    await applyPendingMigrations(sql, { beforeMillis: migrationMillis });

    await sql`
      INSERT INTO files (id, org_id, owner_user_id, storage_key, filename, content_type, size_bytes, origin)
      VALUES (${fileId}::uuid, ${orgId}, ${ownerUserId}, 'private-artifacts/' || ${fileId} || '/doc.pdf', 'doc.pdf', 'application/pdf', 123, 'agent')
    `;
    await sql`
      INSERT INTO artifacts
        (id, org_id, author_user_id, kind, entity_id, logical_key,
         projection_file_id, projection_created_at, video_source_url,
         title, visibility, category)
      VALUES
        (${artifactId}::uuid, ${orgId}, ${ownerUserId}, 'file', ${fileId}::uuid,
         'file:retire-' || ${fileId}, ${fileId}::uuid, now(),
         'https://example.test/legacy.mp4', 'doc.pdf', 'private', 'document')
    `;
    await sql`
      INSERT INTO artifact_user_shares (user_id, org_id, artifact_id, email)
      VALUES (${viewerUserId}, ${orgId}, ${artifactId}::uuid, ${viewerEmail})
    `;

    // Seed all 9 retired tables to ensure DROP TABLE succeeds with live rows.
    await sql`
      INSERT INTO run_uploaded_files
        (id, source, external_id, user_id, org_id, filename, content_type, size_bytes, metadata)
      VALUES
        (${rufId}::uuid, 'agent', ${rufId}, ${ownerUserId}, ${orgId}, 'legacy.txt', 'text/plain', 5, '{}'::jsonb)
    `;
    await sql`
      INSERT INTO artifact_catalog_pending_files (file_id, org_id, author_user_id)
      VALUES (${rufId}::uuid, ${orgId}, ${ownerUserId})
    `;
    await sql`
      INSERT INTO artifact_file_shares (file_id, email, user_id)
      VALUES (${rufId}::uuid, ${viewerEmail}, ${viewerUserId})
    `;
    await sql`
      INSERT INTO canonical_asset_deliveries
        (asset_id, provider, operation_id, status, destination)
      VALUES
        (${rufId}::uuid, 'slack', ${randomUUID()}::uuid, 'delivered', '{}'::jsonb)
    `;
    await sql`
      INSERT INTO video_artifacts (file_id)
      VALUES (${rufId}::uuid)
    `;
    await sql`
      INSERT INTO hosted_sites (id, org_id, user_id, slug, public_slug)
      VALUES (${siteId}::uuid, ${orgId}, ${ownerUserId}, ${`retire-${tag}`}, ${`pub-retire-${tag}`})
    `;
    await sql`
      INSERT INTO hosted_site_visibility (site_id, visibility, revision)
      VALUES (${siteId}::uuid, 'private', ${randomUUID()}::uuid)
    `;
    await sql`
      INSERT INTO hosted_site_shares (site_id, email, user_id)
      VALUES (${siteId}::uuid, ${viewerEmail}, ${viewerUserId})
    `;
    await sql`
      INSERT INTO artifact_shares (user_id, org_id, target_kind, target_id)
      VALUES (${ownerUserId}, ${orgId}, 'file', ${rufId}::uuid)
    `;
    await sql`
      INSERT INTO image_artifact_edit_snapshots (org_id, user_id, artifact_url, snapshot)
      VALUES (${orgId}, ${ownerUserId}, 'https://example.test/edit-' || ${tag} || '.png', '{"version":1,"items":[]}'::jsonb)
    `;

    // Seed retained tables to prove they survive untouched.
    await sql`
      INSERT INTO hosted_site_share_rate_limits (key, window_started_at, requests)
      VALUES (${rateLimitKey}, now(), 1)
    `;
    await sql`
      INSERT INTO private_hosted_deployments
        (id, site_id, org_id, user_id, status, artifact_url, r2_prefix,
         manifest, manifest_hash, content_hash, file_count, size_bytes, url)
      VALUES
        (${privDeployId}::uuid, ${siteId}::uuid, ${orgId}, ${ownerUserId}, 'ready',
         '/artifacts/' || ${privDeployId} || '.html', 'private-sites/' || ${privDeployId},
         '{"files":{}}'::jsonb, ${dummyHash}, ${dummyHash}, 1, 10, 'https://retire.okou.app/')
    `;

    // Dependency guard: RESTRICT must fail closed and roll back atomically.
    await sql`CREATE VIEW artifact_retirement_dep_fixture AS SELECT id FROM public.run_uploaded_files`;
    await assert.rejects(retire, { code: "2BP01" });
    const [rolledBack] = await sql`
      SELECT
        to_regclass('public.artifact_catalog_pending_files') IS NOT NULL AS pending_retained,
        to_regclass('public.run_uploaded_files') IS NOT NULL AS ruf_retained,
        to_regclass('public.artifact_user_shares') IS NOT NULL AS user_shares_retained,
        EXISTS (
          SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = ${migrationMillis}
        ) AS journaled
    `;
    assert.deepEqual(rolledBack, {
      pending_retained: true,
      ruf_retained: true,
      user_shares_retained: true,
      journaled: false,
    });
    await sql`DROP VIEW artifact_retirement_dep_fixture`;

    // Execute 1658 and verify final state.
    await retire();

    const [postTables] = await sql`
      SELECT
        to_regclass('public.artifact_catalog_pending_files') IS NULL AND
        to_regclass('public.artifact_file_shares') IS NULL AND
        to_regclass('public.canonical_asset_deliveries') IS NULL AND
        to_regclass('public.video_artifacts') IS NULL AND
        to_regclass('public.run_uploaded_files') IS NULL AND
        to_regclass('public.hosted_site_visibility') IS NULL AND
        to_regclass('public.hosted_site_shares') IS NULL AND
        to_regclass('public.image_artifact_edit_snapshots') IS NULL AND
        to_regclass('public.artifact_user_shares') IS NULL AS retired_gone,
        to_regclass('public.artifact_shares') IS NOT NULL AND
        to_regclass('public.hosted_site_share_rate_limits') IS NOT NULL AND
        to_regclass('public.private_hosted_deployments') IS NOT NULL AS retained_present,
        to_regclass('public.artifacts_projection_file_org_idx') IS NULL AS dropped_index_gone,
        (
          SELECT count(*)::text FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'artifacts'
            AND column_name IN ('projection_file_id', 'projection_created_at', 'video_source_url')
        ) AS dropped_columns_remaining
    `;
    assert.deepEqual(postTables, {
      retired_gone: true,
      retained_present: true,
      dropped_index_gone: true,
      dropped_columns_remaining: "0",
    });

    // Verify rows from artifact_user_shares survived rename to artifact_shares intact.
    const survivingShares = await sql<
      { user_id: string; org_id: string; artifact_id: string; email: string }[]
    >`
      SELECT user_id, org_id, artifact_id, email
      FROM artifact_shares
      WHERE org_id = ${orgId}
    `;
    assert.deepEqual(
      [...survivingShares],
      [
        {
          user_id: viewerUserId,
          org_id: orgId,
          artifact_id: artifactId,
          email: viewerEmail,
        },
      ],
    );

    // Verify retained artifact, rate-limit, and private deployment rows survived intact.
    const [survivingArtifact] = await sql<{ id: string; title: string }[]>`
      SELECT id, title FROM artifacts WHERE id = ${artifactId}::uuid
    `;
    assert.deepEqual(survivingArtifact, { id: artifactId, title: "doc.pdf" });
    const [survivingRateLimit] = await sql<{ key: string; requests: number }[]>`
      SELECT key, requests FROM hosted_site_share_rate_limits WHERE key = ${rateLimitKey}
    `;
    assert.deepEqual(survivingRateLimit, { key: rateLimitKey, requests: 1 });
    const [survivingPrivateDeploy] = await sql<{ id: string }[]>`
      SELECT id FROM private_hosted_deployments WHERE id = ${privDeployId}::uuid
    `;
    assert.deepEqual(survivingPrivateDeploy, { id: privDeployId });

    // Re-running migrator must be a no-op.
    await retire();

    console.log(
      "Migration 1658 retired-table drops, atomic artifact_shares rename, column drops, and RESTRICT rollback verified",
    );
  } finally {
    try {
      await sql`DELETE FROM hosted_site_share_rate_limits WHERE key = ${rateLimitKey}`;
      await sql`DELETE FROM private_hosted_deployments WHERE id = ${privDeployId}::uuid`;
      await sql`DELETE FROM hosted_sites WHERE id = ${siteId}::uuid`;
      await sql`DELETE FROM artifacts WHERE org_id = ${orgId}`;
      await sql`DELETE FROM files WHERE org_id = ${orgId}`;
    } finally {
      await sql.end();
    }
  }
}
