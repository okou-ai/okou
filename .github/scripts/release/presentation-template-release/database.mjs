import postgres from "postgres";
import {
  loadRegistryHead,
  registerRegistryArchive,
  publishRegistryHead,
  verifyRegistryPublication,
} from "./registry-index.mjs";

const PUBLISHER = "github-actions-presentation-template-publisher";

export function createDatabaseClient(databaseUrl) {
  return postgres(databaseUrl, {
    max: 1,
    connect_timeout: 10,
    connection: { statement_timeout: 30000 },
  });
}

async function loadReleaseState(sql, release) {
  const storageRows = await sql`
    SELECT id, name, s3_prefix, head_version_id, xmin::text AS xmin
    FROM storages
    WHERE id = ${release.storageId}
  `;
  const storage = storageRows[0];
  if (!storage) {
    throw new Error(`${release.slug}: production storage is missing`);
  }
  if (storage.name !== `registry-resource@${release.resourceId}`) {
    throw new Error(`${release.slug}: unexpected production storage name`);
  }
  if (!storage.head_version_id) {
    throw new Error(`${release.slug}: production storage does not have a HEAD`);
  }

  const predecessorRows = await sql`
    SELECT id
    FROM storage_versions
    WHERE
      id = ${storage.head_version_id}
      AND storage_id = ${release.storageId}
  `;
  if (!predecessorRows[0]) {
    throw new Error(
      `${release.slug}: production HEAD does not belong to its storage`,
    );
  }
  const registryHead = await loadRegistryHead(sql, release, storage);
  return { storage, registryHead, previousVersionId: storage.head_version_id };
}

export async function loadStorageState(sql, releases) {
  const state = new Map();
  for (const release of releases) {
    state.set(release.slug, await loadReleaseState(sql, release));
  }
  return state;
}

function assertExistingVersion(existing, release, current) {
  if (
    existing.storage_id !== release.storageId ||
    existing.s3_key !== current.s3Key ||
    Number(existing.size) !== current.pkg.totalSize ||
    Number(existing.archive_size) !== current.archiveSize ||
    existing.file_count !== current.pkg.fileCount
  ) {
    throw new Error(
      `${release.slug}: existing version row has different identity`,
    );
  }
}

async function insertVersion(sql, release, current, sourceCommit) {
  await sql`
    INSERT INTO storage_versions
      (id, storage_id, s3_key, size, archive_size, file_count, message, created_by)
    SELECT
        ${release.newVersionId},
        ${release.storageId},
        ${current.s3Key},
        ${current.pkg.totalSize},
        ${current.archiveSize},
        ${current.pkg.fileCount},
        ${`Template-artifact@${sourceCommit}`},
        ${PUBLISHER}
    WHERE EXISTS (
      SELECT 1 FROM storages WHERE id = ${release.storageId}
        AND xmin::text = ${current.storage.xmin}
        AND head_version_id = ${current.previousVersionId}
        AND name = ${current.storage.name} AND s3_prefix = ${current.storage.s3_prefix}
    )
    ON CONFLICT (id) DO NOTHING
  `;
}

async function registerVersion(sql, release, current, sourceCommit) {
  await insertVersion(sql, release, current, sourceCommit);
  const existingRows = await sql`
    SELECT id, storage_id, s3_key, size, archive_size, file_count
    FROM storage_versions
    WHERE id = ${release.newVersionId}
  `;
  const existing = existingRows[0];
  if (!existing)
    throw new Error(
      `${release.slug}: source changed before version registration`,
    );
  assertExistingVersion(existing, release, current);
}

async function updateStorageHead(sql, release, current) {
  await sql`
    UPDATE storages
    SET
      head_version_id = ${release.newVersionId},
      size = ${current.pkg.totalSize},
      file_count = ${current.pkg.fileCount},
      updated_at = now()
    WHERE id = ${release.storageId} AND xmin::text = ${current.storage.xmin}
      AND name = ${current.storage.name} AND s3_prefix = ${current.storage.s3_prefix}
      AND head_version_id = ${current.previousVersionId}
      AND (head_version_id IS DISTINCT FROM ${release.newVersionId}
        OR size IS DISTINCT FROM ${current.pkg.totalSize}
        OR file_count IS DISTINCT FROM ${current.pkg.fileCount})
  `;
  const [published] = await sql`
    SELECT xmin::text AS xmin FROM storages WHERE id = ${release.storageId}
      AND name = ${current.storage.name} AND s3_prefix = ${current.storage.s3_prefix}
      AND head_version_id = ${release.newVersionId}
      AND size = ${current.pkg.totalSize} AND file_count = ${current.pkg.fileCount}
  `;
  if (!published)
    throw new Error(`${release.slug}: storage HEAD changed before commit`);
  return { ...current, publishedStorageXmin: published.xmin };
}

async function registerRelease(sql, release, current, sourceCommit) {
  if (!current?.pkg) {
    throw new Error(`${release.slug}: verified upload state is missing`);
  }
  await registerRegistryArchive(sql, release, current);
  await registerVersion(sql, release, current, sourceCommit);
  const published = await updateStorageHead(sql, release, current);
  // The independent HEAD is the final publication point, after both immutable
  // objects and version records are verified. Retain partial immutable work.
  await publishRegistryHead(sql, release, published);
  return published;
}

export async function registerPublication(sql, releases, state, sourceCommit) {
  for (const release of releases) {
    const published = await registerRelease(
      sql,
      release,
      state.get(release.slug),
      sourceCommit,
    );
    state.set(release.slug, published);
  }
}

async function verifyRelease(sql, release, current) {
  const rows = await sql`
    SELECT
      s.head_version_id,
      count(v.id)::int AS version_count
    FROM storages s
    JOIN storage_versions v ON v.storage_id = s.id
    WHERE
      s.id = ${release.storageId}
      AND v.id IN (${current.previousVersionId}, ${release.newVersionId})
    GROUP BY s.head_version_id
  `;
  const expectedVersionCount =
    current.previousVersionId === release.newVersionId ? 1 : 2;
  if (
    rows.length !== 1 ||
    rows[0].head_version_id !== release.newVersionId ||
    rows[0].version_count !== expectedVersionCount
  ) {
    throw new Error(
      `${release.slug}: post-publication database verification failed`,
    );
  }
}

export async function verifyDatabasePublication(sql, releases, state) {
  for (const release of releases) {
    await verifyRelease(sql, release, state.get(release.slug));
    await verifyRegistryPublication(sql, release, state.get(release.slug));
  }
}
