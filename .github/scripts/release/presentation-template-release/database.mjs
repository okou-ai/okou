import postgres from "postgres";

export function createDatabaseClient(databaseUrl) {
  return postgres(databaseUrl, {
    max: 1,
    connect_timeout: 10,
    connection: { statement_timeout: 30000 },
  });
}

export async function loadPublicationState(sql, releases) {
  const state = new Map();
  for (const release of releases) {
    const [head] = await sql`
      SELECT h.sha256, h.xmin::text AS xmin, a.version_id
      FROM registry_resource_heads h
      JOIN registry_resource_archives a USING (resource_id, sha256)
      WHERE h.resource_id = ${release.resourceId}
    `;
    if (!head) {
      throw new Error(
        `${release.slug}: registry HEAD is missing; reconcile before publication`,
      );
    }
    state.set(release.slug, { head, previousVersionId: head.version_id });
  }
  return state;
}

async function verifyArchive(sql, release, current) {
  const [row] = await sql`
    SELECT version_id, archive_bytes, file_count, total_bytes
    FROM registry_resource_archives
    WHERE resource_id = ${release.resourceId} AND sha256 = ${release.newSha256}
  `;
  if (
    row &&
    (row.version_id !== release.newVersionId ||
      Number(row.archive_bytes) !== current.archiveSize ||
      row.file_count !== current.pkg.fileCount ||
      Number(row.total_bytes) !== current.pkg.totalSize)
  ) {
    throw new Error(
      `${release.slug}: immutable registry archive metadata conflicts`,
    );
  }
  return Boolean(row);
}

async function registerArchive(sql, release, current) {
  if (await verifyArchive(sql, release, current)) return;
  await sql`
    INSERT INTO registry_resource_archives
      (resource_id, sha256, archive_bytes, version_id, file_count, total_bytes)
    SELECT ${release.resourceId}, ${release.newSha256}, ${current.archiveSize},
      ${release.newVersionId}, ${current.pkg.fileCount}, ${current.pkg.totalSize}
    WHERE EXISTS (
      SELECT 1 FROM registry_resource_heads
      WHERE resource_id = ${release.resourceId} AND sha256 = ${current.head.sha256}
        AND xmin::text = ${current.head.xmin}
    )
    ON CONFLICT (resource_id, sha256) DO NOTHING
  `;
  if (!(await verifyArchive(sql, release, current))) {
    throw new Error(
      `${release.slug}: registry HEAD changed before archive registration`,
    );
  }
}

async function publishHead(sql, release, current) {
  if (current.head.sha256 === release.newSha256) {
    return { ...current, publishedHeadXmin: current.head.xmin };
  }
  const [published] = await sql`
    UPDATE registry_resource_heads SET sha256 = ${release.newSha256}, updated_at = now()
    WHERE resource_id = ${release.resourceId}
      AND sha256 = ${current.head.sha256} AND xmin::text = ${current.head.xmin}
    RETURNING xmin::text AS xmin
  `;
  if (!published) {
    throw new Error(
      `${release.slug}: registry HEAD publication conflicted with another writer`,
    );
  }
  return { ...current, publishedHeadXmin: published.xmin };
}

async function verifyPublication(sql, release, current) {
  if (!(await verifyArchive(sql, release, current))) {
    throw new Error(`${release.slug}: registry archive index is missing`);
  }
  const [head] = await sql`
    SELECT sha256 FROM registry_resource_heads
    WHERE resource_id = ${release.resourceId}
      AND xmin::text = ${current.publishedHeadXmin}
  `;
  if (head?.sha256 !== release.newSha256) {
    throw new Error(
      `${release.slug}: registry HEAD publication conflicted with another writer`,
    );
  }
}

export async function registerPublication(sql, releases, state) {
  for (const release of releases) {
    const current = state.get(release.slug);
    if (!current?.pkg) {
      throw new Error(`${release.slug}: verified upload state is missing`);
    }
    await registerArchive(sql, release, current);
    // The independent HEAD is the final publication point. Retain immutable
    // candidates after an interruption; never undo a competing publication.
    const published = await publishHead(sql, release, current);
    await verifyPublication(sql, release, published);
    state.set(release.slug, published);
  }
}

export async function verifyDatabasePublication(sql, releases, state) {
  for (const release of releases) {
    await verifyPublication(sql, release, state.get(release.slug));
  }
}
