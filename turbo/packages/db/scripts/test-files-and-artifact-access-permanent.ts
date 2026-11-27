import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const MIGRATION_1655_SQL = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../src/migrations/1655_backfill_files_and_artifact_access.sql",
  ),
  "utf8",
);

/**
 * Permanent contract for Release 1 `files`, `artifacts.visibility`/`category`,
 * `artifact_user_shares`, and idempotent backfill invariants from migration 1655.
 */
export async function validatePermanentFilesAndArtifactAccess(
  databaseUrl: string,
) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  const tag = randomUUID().slice(0, 8);
  const orgId = `org-files-r1-${tag}`;
  const ownerUserId = `user-owner-r1-${tag}`;
  const viewerUserId = `user-viewer-r1-${tag}`;

  const userFileId = randomUUID();
  const agentFileId = randomUUID();
  const previewSystemFileId = randomUUID();
  const screenshotSystemFileId = randomUUID();
  const handoffSystemFileId = randomUUID();
  const emptyOrgFileId = randomUUID();
  const pseudoSiteFileId = randomUUID();
  const pseudoWebsiteFileId = randomUUID();
  const imageFileId = randomUUID();
  const imageEntityId = randomUUID();
  const imageArtifactId = randomUUID();
  const fileArtifactId = randomUUID();
  const siteId = randomUUID();
  const siteArtifactId = randomUUID();
  const presSiteId = randomUUID();
  const presEntityId = randomUUID();
  const presArtifactId = randomUUID();
  const legacyPublicSiteId = randomUUID();
  const legacyPublicDeploymentId = randomUUID();
  const legacyPublicSiteArtifactId = randomUUID();
  const legacyPrivateManifestSiteId = randomUUID();
  const legacyPrivateManifestDeploymentId = randomUUID();
  const legacyPrivateManifestArtifactId = randomUUID();
  const unpublishedSiteId = randomUUID();
  const unpublishedSiteArtifactId = randomUUID();
  const deletedSiteId = randomUUID();
  const deletedSiteDeploymentId = randomUUID();
  const deletedSiteArtifactId = randomUUID();
  const explicitPrivateSiteId = randomUUID();
  const explicitPrivateDeploymentId = randomUUID();
  const explicitPrivateArtifactId = randomUUID();
  const cascadeArtifactId = randomUUID();

  try {
    // 1. Verify CHECK constraints on files (origin + non-empty org_id)
    await assert.rejects(
      client.query(
        `INSERT INTO files (id, org_id, owner_user_id, origin)
         VALUES ($1, $2, $3, 'invalid-origin')`,
        [randomUUID(), orgId, ownerUserId],
      ),
      { code: "23514", constraint: "files_origin_check" },
    );
    await assert.rejects(
      client.query(
        `INSERT INTO files (id, org_id, owner_user_id, origin)
         VALUES ($1, '', $2, 'user')`,
        [randomUUID(), ownerUserId],
      ),
      { code: "23514", constraint: "files_org_id_nonempty" },
    );

    // 2. Verify CHECK constraint on artifacts.visibility
    await assert.rejects(
      client.query(
        `INSERT INTO artifacts (id, org_id, author_user_id, kind, entity_id,
           logical_key, projection_created_at, title, visibility)
         VALUES ($1, $2, $3, 'file', $4, $5, now(), 'Invalid visibility', 'unlisted')`,
        [randomUUID(), orgId, ownerUserId, randomUUID(), `file:bad-vis-${tag}`],
      ),
      { code: "23514", constraint: "artifacts_visibility_check" },
    );

    // 3. Seed legacy rows to verify 1653 backfill invariants
    await client.query(
      `INSERT INTO run_uploaded_files
         (id, source, external_id, user_id, org_id, filename, content_type,
          size_bytes, storage_key, classification, metadata)
       VALUES
         ($1::uuid, 'web', $1::text, $9, $10, 'notes.txt', 'text/plain', 10, 'private-artifacts/' || $1::text || '/file', 'input', '{}'::jsonb),
         ($2::uuid, 'agent', $2::text, $9, $10, 'report.pdf', 'application/pdf', 20, 'private-artifacts/' || $2::text || '/file', 'published-output', '{}'::jsonb),
         ($3::uuid, 'web', $3::text, $9, $10, 'cover.png', 'image/png', 30, 'private-artifacts/' || $3::text || '/file', NULL, '{"purpose":"hosted-preview"}'::jsonb),
         ($4::uuid, 'web', $4::text, $9, $10, 'shot.webp', 'image/webp', 40, 'private-artifacts/' || $4::text || '/file', NULL, '{}'::jsonb),
         ($5::uuid, 'web', $5::text, $9, $10, 'handoff.txt', 'text/plain', 50, 'private-artifacts/' || $5::text || '/file', NULL, '{"purpose":"marketing-handoff"}'::jsonb),
         ($6::uuid, 'web', $6::text, $9, '', 'orphan.txt', 'text/plain', 60, 'private-artifacts/' || $6::text || '/file', 'input', '{}'::jsonb),
         ($7::uuid, 'web', $7::text, $9, $10, 'site.html', 'text/html', 70, NULL, NULL, jsonb_build_object('siteId', $11::text)),
         ($8::uuid, 'web', $8::text, $9, $10, 'official.html', 'text/html', 80, NULL, NULL, '{"generatedBy":"zero-official-website"}'::jsonb),
         ($12::uuid, 'agent', $12::text, $9, $10, 'hero.png', 'image/png', 90, 'private-artifacts/' || $12::text || '/file', 'published-output', '{}'::jsonb)`,
      [
        userFileId,
        agentFileId,
        previewSystemFileId,
        screenshotSystemFileId,
        handoffSystemFileId,
        emptyOrgFileId,
        pseudoSiteFileId,
        pseudoWebsiteFileId,
        ownerUserId,
        orgId,
        siteId,
        imageFileId,
      ],
    );

    await client.query(
      `INSERT INTO hosted_sites (id, org_id, user_id, slug, public_slug, active_deployment_id, deleted_at)
       VALUES
         ($1, $8, $9, $10, $11, NULL, NULL),
         ($2, $8, $9, $12, $13, NULL, NULL),
         ($3, $8, $9, $14, $15, $16, NULL),
         ($4, $8, $9, $17, $18, $19, NULL),
         ($5, $8, $9, $20, $21, NULL, NULL),
         ($6, $8, $9, $22, $23, $24, now()),
         ($7, $8, $9, $25, $26, $27, NULL)`,
      [
        siteId,
        presSiteId,
        legacyPublicSiteId,
        legacyPrivateManifestSiteId,
        unpublishedSiteId,
        deletedSiteId,
        explicitPrivateSiteId,
        orgId,
        ownerUserId,
        `site-${tag}`,
        `pub-site-${tag}`,
        `pres-${tag}`,
        `pub-pres-${tag}`,
        `legacy-pub-${tag}`,
        `pub-legacy-${tag}`,
        legacyPublicDeploymentId,
        `legacy-priv-${tag}`,
        `pub-legacy-priv-${tag}`,
        legacyPrivateManifestDeploymentId,
        `unpub-${tag}`,
        `pub-unpub-${tag}`,
        `del-${tag}`,
        `pub-del-${tag}`,
        deletedSiteDeploymentId,
        `expl-priv-${tag}`,
        `pub-expl-priv-${tag}`,
        explicitPrivateDeploymentId,
      ],
    );
    const dummyHash = "0".repeat(64);
    await client.query(
      `INSERT INTO hosted_deployments
         (id, site_id, org_id, user_id, status, r2_prefix, manifest, manifest_hash, content_hash, file_count, size_bytes, url)
       VALUES
         ($1, $2, $9, $10, 'ready', 'sites/legacy-pub', '{"files":{}}'::jsonb, $11, $11, 1, 10, 'https://legacy-pub.okou.app/'),
         ($3, $4, $9, $10, 'ready', 'sites/legacy-priv', '{"access":"owner-private-v1","files":{}}'::jsonb, $11, $11, 1, 10, 'https://legacy-priv.okou.app/'),
         ($5, $6, $9, $10, 'ready', 'sites/deleted', '{"files":{}}'::jsonb, $11, $11, 1, 10, 'https://deleted.okou.app/'),
         ($7, $8, $9, $10, 'ready', 'sites/expl-priv', '{"files":{}}'::jsonb, $11, $11, 1, 10, 'https://expl-priv.okou.app/')`,
      [
        legacyPublicDeploymentId,
        legacyPublicSiteId,
        legacyPrivateManifestDeploymentId,
        legacyPrivateManifestSiteId,
        deletedSiteDeploymentId,
        deletedSiteId,
        explicitPrivateDeploymentId,
        explicitPrivateSiteId,
        orgId,
        ownerUserId,
        dummyHash,
      ],
    );
    await client.query(
      `INSERT INTO hosted_site_visibility (site_id, visibility, revision)
       VALUES
         ($1, 'organization', $4),
         ($2, 'public', $5),
         ($3, 'private', $6)`,
      [
        siteId,
        presSiteId,
        explicitPrivateSiteId,
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ],
    );
    await client.query(
      `INSERT INTO presentation_artifacts (id, hosted_site_id) VALUES ($1, $2)`,
      [presEntityId, presSiteId],
    );
    await client.query(
      `INSERT INTO image_artifacts (id, file_id) VALUES ($1, $2)`,
      [imageEntityId, imageFileId],
    );
    await client.query(
      `INSERT INTO artifacts
         (id, org_id, author_user_id, kind, entity_id, logical_key,
          projection_file_id, projection_created_at, title)
       VALUES
         ($1::uuid, $11, $12, 'file', $13::uuid, 'file:r1-' || $13::text, $13::uuid, now(), 'report.pdf'),
         ($2::uuid, $11, $12, 'image', $14::uuid, 'image:r1-' || $14::text, NULL, now(), 'hero.png'),
         ($3::uuid, $11, $12, 'hosted-site', $15::uuid, 'site:' || $15::text, NULL, now(), 'My Site'),
         ($4::uuid, $11, $12, 'presentation', $16::uuid, 'site:' || $17::text, NULL, now(), 'My Deck'),
         ($5::uuid, $11, $12, 'file', $18::uuid, 'file:cascade-' || $18::text, NULL, now(), 'Cascade'),
         ($6::uuid, $11, $12, 'hosted-site', $19::uuid, 'site:' || $19::text, NULL, now(), 'Legacy Public Site'),
         ($7::uuid, $11, $12, 'hosted-site', $20::uuid, 'site:' || $20::text, NULL, now(), 'Legacy Private Manifest Site'),
         ($8::uuid, $11, $12, 'hosted-site', $21::uuid, 'site:' || $21::text, NULL, now(), 'Unpublished Site'),
         ($9::uuid, $11, $12, 'hosted-site', $22::uuid, 'site:' || $22::text, NULL, now(), 'Deleted Site'),
         ($10::uuid, $11, $12, 'hosted-site', $23::uuid, 'site:' || $23::text, NULL, now(), 'Explicit Private Site')`,
      [
        fileArtifactId,
        imageArtifactId,
        siteArtifactId,
        presArtifactId,
        cascadeArtifactId,
        legacyPublicSiteArtifactId,
        legacyPrivateManifestArtifactId,
        unpublishedSiteArtifactId,
        deletedSiteArtifactId,
        explicitPrivateArtifactId,
        orgId,
        ownerUserId,
        agentFileId,
        imageEntityId,
        siteId,
        presEntityId,
        presSiteId,
        userFileId,
        legacyPublicSiteId,
        legacyPrivateManifestSiteId,
        unpublishedSiteId,
        deletedSiteId,
        explicitPrivateSiteId,
      ],
    );
    await client.query(
      `INSERT INTO artifact_file_shares (file_id, email, user_id)
       VALUES ($1, $2, $3)`,
      [imageFileId, `viewer-${tag}@example.com`, viewerUserId],
    );
    await client.query(
      `INSERT INTO hosted_site_shares (site_id, email, user_id)
       VALUES
         ($1, $3, $4),
         ($2, $3, $4)`,
      [siteId, presSiteId, `viewer-${tag}@example.com`, viewerUserId],
    );

    // 4. Execute migration 1655 statements idempotently (twice) to verify backfill
    const statements = MIGRATION_1655_SQL.split("--> statement-breakpoint")
      .map((stmt) => {
        return stmt.trim();
      })
      .filter((stmt) => {
        return stmt.length > 0 && !stmt.startsWith("SET LOCAL");
      });
    for (let pass = 0; pass < 2; pass += 1) {
      for (const stmt of statements) {
        await client.query(stmt);
      }
    }

    // 5. Verify files backfill: same UUID, accurate origin, non-empty org_id, no pseudo-rows
    const fileRows = await client.query<{
      id: string;
      org_id: string;
      origin: string;
      deleted_at: Date | null;
    }>(
      `SELECT id, org_id, origin, deleted_at FROM files
       WHERE id = ANY($1::uuid[])`,
      [
        [
          userFileId,
          agentFileId,
          previewSystemFileId,
          screenshotSystemFileId,
          handoffSystemFileId,
          emptyOrgFileId,
          pseudoSiteFileId,
          pseudoWebsiteFileId,
          imageFileId,
        ],
      ],
    );
    const byId = new Map(
      fileRows.rows.map((row) => {
        return [row.id, row];
      }),
    );
    assert.equal(byId.get(userFileId)?.origin, "user");
    assert.equal(byId.get(userFileId)?.org_id, orgId);
    assert.equal(byId.get(agentFileId)?.origin, "agent");
    assert.equal(byId.get(imageFileId)?.origin, "agent");
    assert.equal(byId.get(previewSystemFileId)?.origin, "system");
    assert.equal(byId.get(screenshotSystemFileId)?.origin, "system");
    assert.equal(byId.get(handoffSystemFileId)?.origin, "system");
    assert.equal(byId.has(emptyOrgFileId), false);
    assert.equal(byId.has(pseudoSiteFileId), false);
    assert.equal(byId.has(pseudoWebsiteFileId), false);

    // 6. Verify artifacts.visibility backfill for explicit hosted_site_visibility
    //    rows and legacy published sites without hosted_site_visibility rows.
    const visRows = await client.query<{ id: string; visibility: string }>(
      `SELECT id, visibility FROM artifacts WHERE id = ANY($1::uuid[])`,
      [
        [
          fileArtifactId,
          siteArtifactId,
          presArtifactId,
          legacyPublicSiteArtifactId,
          legacyPrivateManifestArtifactId,
          unpublishedSiteArtifactId,
          deletedSiteArtifactId,
          explicitPrivateArtifactId,
        ],
      ],
    );
    const visById = new Map(
      visRows.rows.map((row) => {
        return [row.id, row.visibility];
      }),
    );
    assert.equal(visById.get(fileArtifactId), "private");
    assert.equal(visById.get(siteArtifactId), "organization");
    assert.equal(visById.get(presArtifactId), "public");
    assert.equal(visById.get(legacyPublicSiteArtifactId), "public");
    assert.equal(visById.get(legacyPrivateManifestArtifactId), "private");
    assert.equal(visById.get(unpublishedSiteArtifactId), "private");
    assert.equal(visById.get(deletedSiteArtifactId), "private");
    assert.equal(visById.get(explicitPrivateArtifactId), "private");

    // 7. Verify artifact_user_shares backfill for image (projection_file_id IS NULL), hosted-site, and presentation
    const shareRows = await client.query<{
      user_id: string;
      org_id: string;
      artifact_id: string;
    }>(
      `SELECT user_id, org_id, artifact_id FROM artifact_user_shares
       WHERE user_id = $1 AND org_id = $2`,
      [viewerUserId, orgId],
    );
    assert.deepEqual(
      shareRows.rows
        .map((r) => {
          return r.artifact_id;
        })
        .sort(),
      [imageArtifactId, siteArtifactId, presArtifactId].sort(),
    );

    // 8. Verify composite PK uniqueness and ON DELETE CASCADE on artifact_user_shares
    await assert.rejects(
      client.query(
        `INSERT INTO artifact_user_shares (user_id, org_id, artifact_id, email)
         VALUES ($1, $2, $3, 'dup@example.com')`,
        [viewerUserId, orgId, siteArtifactId],
      ),
      { code: "23505", constraint: "artifact_user_shares_pk" },
    );
    await client.query(
      `INSERT INTO artifact_user_shares (user_id, org_id, artifact_id, email)
       VALUES ($1, $2, $3, 'cascade@example.com')`,
      [viewerUserId, orgId, cascadeArtifactId],
    );
    await client.query(`DELETE FROM artifacts WHERE id = $1`, [
      cascadeArtifactId,
    ]);
    const remainingCascade = await client.query(
      `SELECT 1 FROM artifact_user_shares WHERE artifact_id = $1`,
      [cascadeArtifactId],
    );
    assert.equal(remainingCascade.rowCount, 0);

    // 9. Library soft-delete on artifacts must not soft-delete files
    await client.query(
      `UPDATE artifacts SET deleted_at = now() WHERE id = $1`,
      [fileArtifactId],
    );
    const afterSoftDelete = await client.query<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM files WHERE id = $1`,
      [agentFileId],
    );
    assert.equal(afterSoftDelete.rows[0]?.deleted_at, null);

    console.log(
      "Release 1 files, artifact visibility, and artifact_user_shares invariants verified",
    );
  } finally {
    try {
      await client.query(`DELETE FROM artifacts WHERE org_id = $1`, [orgId]);
      await client.query(`DELETE FROM hosted_sites WHERE org_id = $1`, [orgId]);
      await client.query(
        `DELETE FROM run_uploaded_files WHERE id = ANY($1::uuid[])`,
        [
          [
            userFileId,
            agentFileId,
            previewSystemFileId,
            screenshotSystemFileId,
            handoffSystemFileId,
            emptyOrgFileId,
            pseudoSiteFileId,
            pseudoWebsiteFileId,
            imageFileId,
          ],
        ],
      );
      await client.query(`DELETE FROM files WHERE org_id = $1`, [orgId]);
    } finally {
      await client.end();
    }
  }
}
