import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

/**
 * Permanent schema contract for `files`, `artifacts.visibility` / `category`,
 * `artifact_shares`, and absence of retired artifact/sharing tables & columns
 * on both replayed and freshly generated schemas.
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
  const systemFileId = randomUUID();
  const fileArtifactId = randomUUID();
  const siteArtifactId = randomUUID();
  const cascadeArtifactId = randomUUID();

  try {
    // 0. Verify 9 retired tables + staging table and 3 redundant columns are absent,
    // while active retained tables remain present.
    const retirementState = await client.query<{
      retired_absent: boolean;
      retained_present: boolean;
      dropped_columns_count: string;
      dropped_index_absent: boolean;
    }>(`
      SELECT
        to_regclass('public.artifact_catalog_pending_files') IS NULL AND
        to_regclass('public.artifact_file_shares') IS NULL AND
        to_regclass('public.canonical_asset_deliveries') IS NULL AND
        to_regclass('public.video_artifacts') IS NULL AND
        to_regclass('public.run_uploaded_files') IS NULL AND
        to_regclass('public.hosted_site_visibility') IS NULL AND
        to_regclass('public.hosted_site_shares') IS NULL AND
        to_regclass('public.image_artifact_edit_snapshots') IS NULL AND
        to_regclass('public.artifact_user_shares') IS NULL AS retired_absent,
        to_regclass('public.files') IS NOT NULL AND
        to_regclass('public.artifacts') IS NOT NULL AND
        to_regclass('public.artifact_shares') IS NOT NULL AND
        to_regclass('public.hosted_site_share_rate_limits') IS NOT NULL AND
        to_regclass('public.private_hosted_deployments') IS NOT NULL AS retained_present,
        (
          SELECT count(*)::text
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'artifacts'
            AND column_name IN (
              'projection_file_id',
              'projection_created_at',
              'video_source_url'
            )
        ) AS dropped_columns_count,
        to_regclass('public.artifacts_projection_file_org_idx') IS NULL AS dropped_index_absent
    `);
    assert.deepEqual(retirementState.rows, [
      {
        retired_absent: true,
        retained_present: true,
        dropped_columns_count: "0",
        dropped_index_absent: true,
      },
    ]);

    // 1. Verify CHECK constraints and accepted origins on files
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
    await client.query(
      `INSERT INTO files (id, org_id, owner_user_id, storage_key, filename, content_type, size_bytes, origin)
       VALUES
         ($1::uuid, $4, $5, 'private-artifacts/' || ($1::uuid)::text || '/notes.txt', 'notes.txt', 'text/plain', 10, 'user'),
         ($2::uuid, $4, $5, 'private-artifacts/' || ($2::uuid)::text || '/report.pdf', 'report.pdf', 'application/pdf', 20, 'agent'),
         ($3::uuid, $4, $5, 'private-artifacts/' || ($3::uuid)::text || '/cover.png', 'cover.png', 'image/png', 30, 'system')`,
      [userFileId, agentFileId, systemFileId, orgId, ownerUserId],
    );

    // 2. Verify validated CHECK constraint, default value, and partial catalog index on artifacts
    const visibilityConstraint = await client.query<{ validated: boolean }>(
      `SELECT convalidated AS validated
       FROM pg_constraint
       WHERE conrelid = 'public.artifacts'::regclass
         AND conname = 'artifacts_visibility_check'`,
    );
    assert.deepEqual(visibilityConstraint.rows, [{ validated: true }]);

    await assert.rejects(
      client.query(
        `INSERT INTO artifacts (id, org_id, author_user_id, kind, entity_id,
           logical_key, title, visibility)
         VALUES ($1, $2, $3, 'file', $4, $5, 'Invalid visibility', 'unlisted')`,
        [randomUUID(), orgId, ownerUserId, randomUUID(), `file:bad-vis-${tag}`],
      ),
      { code: "23514", constraint: "artifacts_visibility_check" },
    );

    const categoryIndex = await client.query<{
      valid: boolean;
      definition: string;
    }>(
      `SELECT i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS definition
       FROM pg_index i
       WHERE i.indexrelid = 'artifacts_author_category_created_idx'::regclass`,
    );
    assert.equal(categoryIndex.rows[0]?.valid, true);
    assert.match(
      categoryIndex.rows[0]?.definition ?? "",
      /\(org_id, author_user_id, category, created_at DESC NULLS LAST, id DESC NULLS LAST\)/,
    );
    assert.match(
      categoryIndex.rows[0]?.definition ?? "",
      /WHERE \(deleted_at IS NULL\)/,
    );

    const insertedArtifacts = await client.query<{
      id: string;
      visibility: string;
      category: string | null;
    }>(
      `INSERT INTO artifacts
         (id, org_id, author_user_id, kind, entity_id, logical_key,
          title, category)
       VALUES
         ($1::uuid, $4, $5, 'file', $6::uuid, 'file:perm-' || ($6::uuid)::text, 'report.pdf', 'document'),
         ($2::uuid, $4, $5, 'hosted-site', $7::uuid, 'site:perm-' || ($7::uuid)::text, 'Site', 'website'),
         ($3::uuid, $4, $5, 'file', $8::uuid, 'file:cascade-' || ($8::uuid)::text, 'Cascade', 'document')
       RETURNING id, visibility, category`,
      [
        fileArtifactId,
        siteArtifactId,
        cascadeArtifactId,
        orgId,
        ownerUserId,
        agentFileId,
        randomUUID(),
        userFileId,
      ],
    );
    for (const row of insertedArtifacts.rows) {
      assert.equal(row.visibility, "private");
    }

    // 3. Verify canonical artifact_shares constraints, index, NOT NULL email,
    // composite PK uniqueness, and ON DELETE CASCADE.
    const shareConstraints = await client.query<{
      conname: string;
      contype: string;
      validated: boolean;
      confdeltype: string;
    }>(
      `SELECT conname, contype, convalidated AS validated, confdeltype
       FROM pg_constraint
       WHERE conrelid = 'public.artifact_shares'::regclass
         AND contype IN ('p', 'f')
       ORDER BY contype, conname`,
    );
    assert.deepEqual(shareConstraints.rows, [
      {
        conname: "artifact_shares_artifact_id_artifacts_id_fk",
        contype: "f",
        validated: true,
        confdeltype: "c",
      },
      {
        conname: "artifact_shares_pk",
        contype: "p",
        validated: true,
        confdeltype: " ",
      },
    ]);

    const shareIndex = await client.query<{
      valid: boolean;
      definition: string;
    }>(
      `SELECT i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS definition
       FROM pg_index i
       WHERE i.indexrelid = 'public.artifact_shares_artifact_idx'::regclass`,
    );
    assert.equal(shareIndex.rows[0]?.valid, true);
    assert.match(shareIndex.rows[0]?.definition ?? "", /\(artifact_id\)/);

    await assert.rejects(
      client.query(
        `INSERT INTO artifact_shares (user_id, org_id, artifact_id, email)
         VALUES ($1, $2, $3, NULL)`,
        [viewerUserId, orgId, siteArtifactId],
      ),
      { code: "23502" },
    );

    await client.query(
      `INSERT INTO artifact_shares (user_id, org_id, artifact_id, email)
       VALUES ($1, $2, $3, $4)`,
      [viewerUserId, orgId, siteArtifactId, `viewer-${tag}@example.com`],
    );
    await assert.rejects(
      client.query(
        `INSERT INTO artifact_shares (user_id, org_id, artifact_id, email)
         VALUES ($1, $2, $3, 'dup@example.com')`,
        [viewerUserId, orgId, siteArtifactId],
      ),
      { code: "23505", constraint: "artifact_shares_pk" },
    );

    await client.query(
      `INSERT INTO artifact_shares (user_id, org_id, artifact_id, email)
       VALUES ($1, $2, $3, 'cascade@example.com')`,
      [viewerUserId, orgId, cascadeArtifactId],
    );
    await client.query(`DELETE FROM artifacts WHERE id = $1`, [
      cascadeArtifactId,
    ]);
    const remainingCascade = await client.query(
      `SELECT 1 FROM artifact_shares WHERE artifact_id = $1`,
      [cascadeArtifactId],
    );
    assert.equal(remainingCascade.rowCount, 0);

    // 4. Library soft-delete on artifacts must not soft-delete files
    await client.query(
      `UPDATE artifacts SET deleted_at = now() WHERE id = $1`,
      [fileArtifactId],
    );
    const afterSoftDelete = await client.query<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM files WHERE id = $1`,
      [agentFileId],
    );
    assert.equal(afterSoftDelete.rows[0]?.deleted_at, null);

    // 5. Verify image_artifacts.file_id FK targets files(id) ON DELETE CASCADE
    const imageArtifactFks = await client.query<{
      conname: string;
      validated: boolean;
      confdeltype: string;
      target_table: string;
    }>(
      `SELECT c.conname, c.convalidated AS validated, c.confdeltype,
              c.confrelid::regclass::text AS target_table
       FROM pg_constraint c
       WHERE c.conrelid = 'public.image_artifacts'::regclass
         AND c.contype = 'f'
         AND c.conname LIKE 'image_artifacts_file_id_%'
       ORDER BY c.conname`,
    );
    assert.deepEqual(imageArtifactFks.rows, [
      {
        conname: "image_artifacts_file_id_files_id_fk",
        validated: true,
        confdeltype: "c",
        target_table: "files",
      },
    ]);

    await assert.rejects(
      client.query(
        `INSERT INTO image_artifacts (id, file_id) VALUES ($1, $2)`,
        [randomUUID(), randomUUID()],
      ),
      { code: "23503", constraint: "image_artifacts_file_id_files_id_fk" },
    );

    const cascadeFileId = randomUUID();
    const cascadeImageId = randomUUID();
    await client.query(
      `INSERT INTO files (id, org_id, owner_user_id, storage_key, filename, content_type, size_bytes, origin)
       VALUES ($1::uuid, $2, $3, 'private-artifacts/' || ($1::uuid)::text || '/img.png', 'img.png', 'image/png', 42, 'agent')`,
      [cascadeFileId, orgId, ownerUserId],
    );
    await client.query(
      `INSERT INTO image_artifacts (id, file_id) VALUES ($1, $2)`,
      [cascadeImageId, cascadeFileId],
    );
    await client.query(`DELETE FROM files WHERE id = $1`, [cascadeFileId]);
    const remainingImage = await client.query(
      `SELECT 1 FROM image_artifacts WHERE id = $1`,
      [cascadeImageId],
    );
    assert.equal(remainingImage.rowCount, 0);

    console.log(
      "Permanent files, image_artifacts FK, artifact visibility, artifact_shares, and retirement invariants verified",
    );
  } finally {
    try {
      await client.query(`DELETE FROM artifacts WHERE org_id = $1`, [orgId]);
      await client.query(`DELETE FROM files WHERE org_id = $1`, [orgId]);
    } finally {
      await client.end();
    }
  }
}
