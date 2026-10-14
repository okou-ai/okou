import postgres from "postgres";

const PUBLISHER = "github-actions-presentation-template-publisher";

export function createDatabaseClient(databaseUrl) {
  return postgres(databaseUrl, { max: 1 });
}

async function loadReleaseState(sql, release) {
  const storageRows = await sql`
    SELECT id, name, s3_prefix, head_version_id
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
  return { storage, previousVersionId: storage.head_version_id };
}

export async function loadStorageState(sql, releases) {
  const state = new Map();
  for (const release of releases) {
    state.set(release.slug, await loadReleaseState(sql, release));
  }
  return state;
}

function assertLockedStorage(locked, release, current) {
  if (!locked || locked.name !== `registry-resource@${release.resourceId}`) {
    throw new Error(`${release.slug}: storage identity changed before commit`);
  }
  if (
    locked.head_version_id !== current.previousVersionId &&
    locked.head_version_id !== release.newVersionId
  ) {
    throw new Error(`${release.slug}: storage HEAD changed before commit`);
  }
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

async function insertVersion(tx, release, current, sourceCommit) {
  await tx`
    INSERT INTO storage_versions
      (id, storage_id, s3_key, size, archive_size, file_count, message, created_by)
    VALUES
      (
        ${release.newVersionId},
        ${release.storageId},
        ${current.s3Key},
        ${current.pkg.totalSize},
        ${current.archiveSize},
        ${current.pkg.fileCount},
        ${`Template-artifact@${sourceCommit}`},
        ${PUBLISHER}
      )
  `;
}

async function registerVersion(tx, release, current, sourceCommit) {
  const existingRows = await tx`
    SELECT id, storage_id, s3_key, size, archive_size, file_count
    FROM storage_versions
    WHERE id = ${release.newVersionId}
  `;
  const existing = existingRows[0];
  if (existing) {
    assertExistingVersion(existing, release, current);
  } else {
    await insertVersion(tx, release, current, sourceCommit);
  }
}

async function updateStorageHead(tx, release, current, locked) {
  const alreadyCurrent =
    locked.head_version_id === release.newVersionId &&
    Number(locked.size) === current.pkg.totalSize &&
    locked.file_count === current.pkg.fileCount;
  if (alreadyCurrent) {
    return;
  }

  await tx`
    UPDATE storages
    SET
      head_version_id = ${release.newVersionId},
      size = ${current.pkg.totalSize},
      file_count = ${current.pkg.fileCount},
      updated_at = now()
    WHERE id = ${release.storageId}
  `;
}

async function registerRelease(tx, release, current, sourceCommit) {
  if (!current?.pkg) {
    throw new Error(`${release.slug}: verified upload state is missing`);
  }
  const lockedRows = await tx`
    SELECT id, name, head_version_id, size, file_count
    FROM storages
    WHERE id = ${release.storageId}
    FOR UPDATE
  `;
  const locked = lockedRows[0];
  assertLockedStorage(locked, release, current);
  await registerVersion(tx, release, current, sourceCommit);
  await updateStorageHead(tx, release, current, locked);
}

export async function registerPublication(sql, releases, state, sourceCommit) {
  await sql.begin(async (tx) => {
    for (const release of releases) {
      await registerRelease(tx, release, state.get(release.slug), sourceCommit);
    }
  });
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
  }
}
