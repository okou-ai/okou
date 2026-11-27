import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { array, object, string } from "zod";
import { applyPendingMigrations } from "./migration-runner";

function highUuid(n: number): string {
  return `ffffffff-ffff-4fff-8fff-${n.toString(16).padStart(12, "0")}`;
}

function createBackfillIds() {
  const tag = randomUUID().slice(0, 8);
  return {
    tag,
    orgId: `org-backfill-1655-${tag}`,
    ownerUserId: `user-owner-1655-${tag}`,
    viewerUserId: `user-viewer-1655-${tag}`,
    viewerEmail: `viewer-${tag}@example.com`,
    userFileId: highUuid(1),
    agentFileId: highUuid(2),
    previewSystemFileId: highUuid(3),
    screenshotSystemFileId: highUuid(4),
    handoffSystemFileId: highUuid(5),
    emptyOrgFileId: highUuid(6),
    pseudoSiteFileId: highUuid(7),
    pseudoWebsiteFileId: highUuid(8),
    imageFileId: highUuid(9),
    imageEntityId: highUuid(10),
    imageArtifactId: highUuid(11),
    fileArtifactId: highUuid(12),
    siteId: highUuid(13),
    siteArtifactId: highUuid(14),
    presSiteId: highUuid(15),
    presEntityId: highUuid(16),
    presArtifactId: highUuid(17),
    legacyPublicSiteId: highUuid(18),
    legacyPublicDeploymentId: highUuid(19),
    legacyPublicSiteArtifactId: highUuid(20),
    legacyPrivateManifestSiteId: highUuid(21),
    legacyPrivateManifestDeploymentId: highUuid(22),
    legacyPrivateManifestArtifactId: highUuid(23),
    unpublishedSiteId: highUuid(24),
    unpublishedSiteArtifactId: highUuid(25),
    deletedSiteId: highUuid(26),
    deletedSiteDeploymentId: highUuid(27),
    deletedSiteArtifactId: highUuid(28),
    explicitPrivateSiteId: highUuid(29),
    explicitPrivateDeploymentId: highUuid(30),
    explicitPrivateArtifactId: highUuid(31),
    sharedThreadArtifactId: highUuid(32),
  };
}

type BackfillIds = ReturnType<typeof createBackfillIds>;

async function seedBackfillFixtures(sql: postgres.Sql, ids: BackfillIds) {
  // Seed 1,005 low-UUID rows so cursor batching crosses the 1,000-row boundary.
  await sql`
    INSERT INTO run_uploaded_files
      (id, source, external_id, user_id, org_id, filename, content_type,
       size_bytes, storage_key, classification, metadata)
    SELECT
      ('00000000-0000-4000-8000-' || lpad(to_hex(i), 12, '0'))::uuid,
      'web',
      'skip-' || i::text,
      ${ids.ownerUserId},
      '',
      'orphan-' || i::text || '.txt',
      'text/plain',
      1,
      'private-artifacts/skip-' || i::text,
      'input',
      '{}'::jsonb
    FROM generate_series(1, 1005) AS i
  `;
  await sql`
    INSERT INTO artifacts
      (id, org_id, author_user_id, kind, entity_id, logical_key,
       projection_created_at, title)
    SELECT
      ('00000000-0000-4000-8000-' || lpad(to_hex(i), 12, '0'))::uuid,
      ${ids.orgId},
      ${ids.ownerUserId},
      'file',
      gen_random_uuid(),
      'file:batch-pad-' || i::text,
      now(),
      'pad-' || i::text || '.txt'
    FROM generate_series(1, 1005) AS i
  `;

  await sql`
    INSERT INTO run_uploaded_files
      (id, source, external_id, user_id, org_id, filename, content_type,
       size_bytes, storage_key, classification, metadata)
    VALUES
      (${ids.userFileId}::uuid, 'web', ${ids.userFileId}, ${ids.ownerUserId}, ${ids.orgId}, 'notes.txt', 'text/plain', 10, 'private-artifacts/' || ${ids.userFileId} || '/file', 'input', '{}'::jsonb),
      (${ids.agentFileId}::uuid, 'agent', ${ids.agentFileId}, ${ids.ownerUserId}, ${ids.orgId}, 'report.pdf', 'application/pdf', 20, 'private-artifacts/' || ${ids.agentFileId} || '/file', 'published-output', '{}'::jsonb),
      (${ids.previewSystemFileId}::uuid, 'web', ${ids.previewSystemFileId}, ${ids.ownerUserId}, ${ids.orgId}, 'cover.png', 'image/png', 30, 'private-artifacts/' || ${ids.previewSystemFileId} || '/file', NULL, '{"purpose":"hosted-preview"}'::jsonb),
      (${ids.screenshotSystemFileId}::uuid, 'web', ${ids.screenshotSystemFileId}, ${ids.ownerUserId}, ${ids.orgId}, 'shot.webp', 'image/webp', 40, 'private-artifacts/' || ${ids.screenshotSystemFileId} || '/file', NULL, '{}'::jsonb),
      (${ids.handoffSystemFileId}::uuid, 'web', ${ids.handoffSystemFileId}, ${ids.ownerUserId}, ${ids.orgId}, 'handoff.txt', 'text/plain', 50, 'private-artifacts/' || ${ids.handoffSystemFileId} || '/file', NULL, '{"purpose":"marketing-handoff"}'::jsonb),
      (${ids.emptyOrgFileId}::uuid, 'web', ${ids.emptyOrgFileId}, ${ids.ownerUserId}, '', 'orphan.txt', 'text/plain', 60, 'private-artifacts/' || ${ids.emptyOrgFileId} || '/file', 'input', '{}'::jsonb),
      (${ids.pseudoSiteFileId}::uuid, 'web', ${ids.pseudoSiteFileId}, ${ids.ownerUserId}, ${ids.orgId}, 'site.html', 'text/html', 70, NULL, NULL, jsonb_build_object('siteId', ${ids.siteId}::text)),
      (${ids.pseudoWebsiteFileId}::uuid, 'web', ${ids.pseudoWebsiteFileId}, ${ids.ownerUserId}, ${ids.orgId}, 'official.html', 'text/html', 80, NULL, NULL, '{"generatedBy":"zero-official-website"}'::jsonb),
      (${ids.imageFileId}::uuid, 'agent', ${ids.imageFileId}, ${ids.ownerUserId}, ${ids.orgId}, 'hero.png', 'image/png', 90, 'private-artifacts/' || ${ids.imageFileId} || '/file', 'published-output', '{}'::jsonb)
  `;

  await sql`
    INSERT INTO hosted_sites (id, org_id, user_id, slug, public_slug, active_deployment_id, deleted_at)
    VALUES
      (${ids.siteId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, ${`site-${ids.tag}`}, ${`pub-site-${ids.tag}`}, NULL, NULL),
      (${ids.presSiteId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, ${`pres-${ids.tag}`}, ${`pub-pres-${ids.tag}`}, NULL, NULL),
      (${ids.legacyPublicSiteId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, ${`legacy-pub-${ids.tag}`}, ${`pub-legacy-${ids.tag}`}, ${ids.legacyPublicDeploymentId}::uuid, NULL),
      (${ids.legacyPrivateManifestSiteId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, ${`legacy-priv-${ids.tag}`}, ${`pub-legacy-priv-${ids.tag}`}, ${ids.legacyPrivateManifestDeploymentId}::uuid, NULL),
      (${ids.unpublishedSiteId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, ${`unpub-${ids.tag}`}, ${`pub-unpub-${ids.tag}`}, NULL, NULL),
      (${ids.deletedSiteId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, ${`del-${ids.tag}`}, ${`pub-del-${ids.tag}`}, ${ids.deletedSiteDeploymentId}::uuid, now()),
      (${ids.explicitPrivateSiteId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, ${`expl-priv-${ids.tag}`}, ${`pub-expl-priv-${ids.tag}`}, ${ids.explicitPrivateDeploymentId}::uuid, NULL)
  `;

  const dummyHash = "0".repeat(64);
  await sql`
    INSERT INTO hosted_deployments
      (id, site_id, org_id, user_id, status, r2_prefix, manifest, manifest_hash, content_hash, file_count, size_bytes, url)
    VALUES
      (${ids.legacyPublicDeploymentId}::uuid, ${ids.legacyPublicSiteId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'ready', 'sites/legacy-pub', '{"files":{}}'::jsonb, ${dummyHash}, ${dummyHash}, 1, 10, 'https://legacy-pub.okou.app/'),
      (${ids.legacyPrivateManifestDeploymentId}::uuid, ${ids.legacyPrivateManifestSiteId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'ready', 'sites/legacy-priv', '{"access":"owner-private-v1","files":{}}'::jsonb, ${dummyHash}, ${dummyHash}, 1, 10, 'https://legacy-priv.okou.app/'),
      (${ids.deletedSiteDeploymentId}::uuid, ${ids.deletedSiteId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'ready', 'sites/deleted', '{"files":{}}'::jsonb, ${dummyHash}, ${dummyHash}, 1, 10, 'https://deleted.okou.app/'),
      (${ids.explicitPrivateDeploymentId}::uuid, ${ids.explicitPrivateSiteId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'ready', 'sites/expl-priv', '{"files":{}}'::jsonb, ${dummyHash}, ${dummyHash}, 1, 10, 'https://expl-priv.okou.app/')
  `;

  await sql`
    INSERT INTO hosted_site_visibility (site_id, visibility, revision)
    VALUES
      (${ids.siteId}::uuid, 'organization', ${randomUUID()}::uuid),
      (${ids.presSiteId}::uuid, 'public', ${randomUUID()}::uuid),
      (${ids.explicitPrivateSiteId}::uuid, 'private', ${randomUUID()}::uuid)
  `;
  await sql`INSERT INTO presentation_artifacts (id, hosted_site_id) VALUES (${ids.presEntityId}::uuid, ${ids.presSiteId}::uuid)`;
  await sql`INSERT INTO image_artifacts (id, file_id) VALUES (${ids.imageEntityId}::uuid, ${ids.imageFileId}::uuid)`;

  await sql`
    INSERT INTO artifacts
      (id, org_id, author_user_id, kind, entity_id, logical_key,
       projection_file_id, projection_created_at, title)
    VALUES
      (${ids.fileArtifactId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'file', ${ids.agentFileId}::uuid, 'file:r1-' || ${ids.agentFileId}, ${ids.agentFileId}::uuid, now(), 'report.pdf'),
      (${ids.imageArtifactId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'image', ${ids.imageEntityId}::uuid, 'image:r1-' || ${ids.imageEntityId}, NULL, now(), 'hero.png'),
      (${ids.siteArtifactId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'hosted-site', ${ids.siteId}::uuid, 'site:' || ${ids.siteId}, NULL, now(), 'My Site'),
      (${ids.presArtifactId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'presentation', ${ids.presEntityId}::uuid, 'site:' || ${ids.presSiteId}, NULL, now(), 'My Deck'),
      (${ids.legacyPublicSiteArtifactId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'hosted-site', ${ids.legacyPublicSiteId}::uuid, 'site:' || ${ids.legacyPublicSiteId}, NULL, now(), 'Legacy Public Site'),
      (${ids.legacyPrivateManifestArtifactId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'hosted-site', ${ids.legacyPrivateManifestSiteId}::uuid, 'site:' || ${ids.legacyPrivateManifestSiteId}, NULL, now(), 'Legacy Private Manifest Site'),
      (${ids.unpublishedSiteArtifactId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'hosted-site', ${ids.unpublishedSiteId}::uuid, 'site:' || ${ids.unpublishedSiteId}, NULL, now(), 'Unpublished Site'),
      (${ids.deletedSiteArtifactId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'hosted-site', ${ids.deletedSiteId}::uuid, 'site:' || ${ids.deletedSiteId}, NULL, now(), 'Deleted Site'),
      (${ids.explicitPrivateArtifactId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'hosted-site', ${ids.explicitPrivateSiteId}::uuid, 'site:' || ${ids.explicitPrivateSiteId}, NULL, now(), 'Explicit Private Site'),
      (${ids.sharedThreadArtifactId}::uuid, ${ids.orgId}, ${ids.ownerUserId}, 'file', ${randomUUID()}::uuid, 'shared-thread:' || ${ids.tag}, NULL, now(), 'Shared Thread Snapshot')
  `;

  await sql`
    INSERT INTO artifact_file_shares (file_id, email, user_id)
    VALUES (${ids.imageFileId}::uuid, ${ids.viewerEmail}, ${ids.viewerUserId})
  `;
  await sql`
    INSERT INTO hosted_site_shares (site_id, email, user_id)
    VALUES
      (${ids.siteId}::uuid, ${ids.viewerEmail}, ${ids.viewerUserId}),
      (${ids.presSiteId}::uuid, ${ids.viewerEmail}, ${ids.viewerUserId})
  `;
}

async function verifyFilesBackfill(sql: postgres.Sql, ids: BackfillIds) {
  const trackedFileIds = [
    ids.userFileId,
    ids.agentFileId,
    ids.previewSystemFileId,
    ids.screenshotSystemFileId,
    ids.handoffSystemFileId,
    ids.emptyOrgFileId,
    ids.pseudoSiteFileId,
    ids.pseudoWebsiteFileId,
    ids.imageFileId,
  ];
  const fileRows = await sql<{ id: string; org_id: string; origin: string }[]>`
    SELECT id, org_id, origin FROM files
    WHERE id = ANY(${trackedFileIds}::uuid[])
  `;
  const byId = new Map(
    fileRows.map((row) => {
      return [row.id, row];
    }),
  );
  assert.deepEqual(byId.get(ids.userFileId), {
    id: ids.userFileId,
    org_id: ids.orgId,
    origin: "user",
  });
  assert.equal(byId.get(ids.agentFileId)?.origin, "agent");
  assert.equal(byId.get(ids.imageFileId)?.origin, "agent");
  assert.equal(byId.get(ids.previewSystemFileId)?.origin, "system");
  assert.equal(byId.get(ids.screenshotSystemFileId)?.origin, "system");
  assert.equal(byId.get(ids.handoffSystemFileId)?.origin, "system");
  assert.equal(byId.has(ids.emptyOrgFileId), false);
  assert.equal(byId.has(ids.pseudoSiteFileId), false);
  assert.equal(byId.has(ids.pseudoWebsiteFileId), false);
}

async function verifyArtifactsAndSharesBackfill(
  sql: postgres.Sql,
  ids: BackfillIds,
) {
  const trackedArtifactIds = [
    ids.fileArtifactId,
    ids.imageArtifactId,
    ids.siteArtifactId,
    ids.presArtifactId,
    ids.legacyPublicSiteArtifactId,
    ids.legacyPrivateManifestArtifactId,
    ids.unpublishedSiteArtifactId,
    ids.deletedSiteArtifactId,
    ids.explicitPrivateArtifactId,
    ids.sharedThreadArtifactId,
  ];
  const artRows = await sql<
    { id: string; visibility: string; category: string | null }[]
  >`
    SELECT id, visibility, category FROM artifacts
    WHERE id = ANY(${trackedArtifactIds}::uuid[])
  `;
  const byId = new Map(
    artRows.map((row) => {
      return [row.id, row];
    }),
  );
  const expected: readonly [string, string, string][] = [
    [ids.fileArtifactId, "private", "document"],
    [ids.imageArtifactId, "private", "image"],
    [ids.siteArtifactId, "organization", "website"],
    [ids.presArtifactId, "public", "presentation"],
    [ids.legacyPublicSiteArtifactId, "public", "website"],
    [ids.legacyPrivateManifestArtifactId, "private", "website"],
    [ids.unpublishedSiteArtifactId, "private", "website"],
    [ids.deletedSiteArtifactId, "private", "website"],
    [ids.explicitPrivateArtifactId, "private", "website"],
    [ids.sharedThreadArtifactId, "private", "other"],
  ];
  for (const [id, visibility, category] of expected) {
    assert.deepEqual(byId.get(id), { id, visibility, category });
  }

  const uncategorized = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM artifacts
    WHERE org_id = ${ids.orgId} AND category IS NULL
  `;
  assert.equal(uncategorized[0]?.count, "0");

  const shareRows = await sql<{ artifact_id: string; email: string }[]>`
    SELECT artifact_id, email FROM artifact_user_shares
    WHERE user_id = ${ids.viewerUserId} AND org_id = ${ids.orgId}
    ORDER BY artifact_id
  `;
  assert.deepEqual(
    [...shareRows],
    [ids.imageArtifactId, ids.siteArtifactId, ids.presArtifactId]
      .sort()
      .map((artifactId) => {
        return { artifact_id: artifactId, email: ids.viewerEmail };
      }),
  );
}

async function verifyBatchReplayIdempotency(sql: postgres.Sql, orgId: string) {
  const beforeFiles = await sql<{ id: string; xmin: string }[]>`
    SELECT id, xmin::text AS xmin FROM files
    WHERE org_id = ${orgId} ORDER BY id
  `;
  const beforeArtifacts = await sql<{ id: string; xmin: string }[]>`
    SELECT id, xmin::text AS xmin FROM artifacts
    WHERE org_id = ${orgId} ORDER BY id
  `;
  const migrationSql = await readFile(
    new URL(
      "../src/migrations/1655_backfill_files_and_artifact_access.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const batchStatements = migrationSql
    .split("--> statement-breakpoint")
    .map((s) => {
      return s.trim();
    })
    .filter((s) => {
      return s.includes("-- okou:batch-by-uuid");
    });
  assert.equal(batchStatements.length, 6);
  for (const stmt of batchStatements) {
    let cursor: string | null = null;
    do {
      const [page] = array(object({ next_cursor: string().nullable() })).parse(
        await sql.unsafe(stmt, [cursor]),
      );
      assert.ok(page);
      cursor = page.next_cursor;
    } while (cursor !== null);
  }
  assert.deepEqual(
    [
      ...(await sql<{ id: string; xmin: string }[]>`
        SELECT id, xmin::text AS xmin FROM files
        WHERE org_id = ${orgId} ORDER BY id
      `),
    ],
    [...beforeFiles],
  );
  assert.deepEqual(
    [
      ...(await sql<{ id: string; xmin: string }[]>`
        SELECT id, xmin::text AS xmin FROM artifacts
        WHERE org_id = ${orgId} ORDER BY id
      `),
    ],
    [...beforeArtifacts],
  );
}

/**
 * Transition validator for migration 1655: seeds legacy rows right after 1654
 * (including >1,000 rows to cross `-- okou:batch-by-uuid` boundaries), executes
 * 1655 through `applyPendingMigrations`, verifies every backfilled table plus
 * constraint validation and concurrent index build, and confirms replay is a
 * zero-rewrite no-op.
 */
export async function validateFilesAndArtifactAccessBackfill(
  databaseUrl: string,
  migrationMillis: number,
) {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  const ids = createBackfillIds();

  try {
    await applyPendingMigrations(sql, { beforeMillis: migrationMillis });

    const preConstraint = await sql<{ validated: boolean }[]>`
      SELECT convalidated AS validated
      FROM pg_constraint
      WHERE conrelid = 'public.artifacts'::regclass
        AND conname = 'artifacts_visibility_check'
    `;
    assert.deepEqual([...preConstraint], [{ validated: false }]);
    const preIndex = await sql<{ exists: boolean }[]>`
      SELECT to_regclass('public.artifacts_author_category_created_idx') IS NOT NULL AS exists
    `;
    assert.deepEqual([...preIndex], [{ exists: false }]);

    await seedBackfillFixtures(sql, ids);
    await applyPendingMigrations(sql, { beforeMillis: migrationMillis + 1 });

    await verifyFilesBackfill(sql, ids);
    await verifyArtifactsAndSharesBackfill(sql, ids);

    const postConstraint = await sql<{ validated: boolean }[]>`
      SELECT convalidated AS validated
      FROM pg_constraint
      WHERE conrelid = 'public.artifacts'::regclass
        AND conname = 'artifacts_visibility_check'
    `;
    assert.deepEqual([...postConstraint], [{ validated: true }]);
    const postIndex = await sql<{ valid: boolean }[]>`
      SELECT i.indisvalid AS valid
      FROM pg_index i
      WHERE i.indexrelid = 'artifacts_author_category_created_idx'::regclass
    `;
    assert.deepEqual([...postIndex], [{ valid: true }]);

    await verifyBatchReplayIdempotency(sql, ids.orgId);

    console.log(
      "Migration 1655 batched backfill, validation, concurrent index, and replay idempotency verified",
    );
  } finally {
    try {
      await sql`DELETE FROM artifacts WHERE org_id = ${ids.orgId}`;
      await sql`DELETE FROM hosted_sites WHERE org_id = ${ids.orgId}`;
      await sql`DELETE FROM run_uploaded_files WHERE user_id = ${ids.ownerUserId}`;
      await sql`DELETE FROM files WHERE org_id = ${ids.orgId}`;
    } finally {
      await sql.end();
    }
  }
}
