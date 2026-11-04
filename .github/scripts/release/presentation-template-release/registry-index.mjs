export async function loadRegistryHead(sql, release, storage) {
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
  // A resumed publication can have committed the legacy HEAD before its final
  // registry HEAD. Other pre-existing divergence needs operator reconciliation.
  if (
    head.version_id !== storage.head_version_id &&
    storage.head_version_id !== release.newVersionId
  ) {
    throw new Error(
      `${release.slug}: registry and Storage HEADs differ; reconcile before publication`,
    );
  }
  return head;
}

function matchesArchive(row, release, current) {
  return (
    row &&
    row.version_id === release.newVersionId &&
    Number(row.archive_bytes) === current.archiveSize &&
    row.file_count === current.pkg.fileCount &&
    Number(row.total_bytes) === current.pkg.totalSize
  );
}

export async function verifyRegistryArchive(sql, release, current) {
  const [row] = await sql`
    SELECT version_id, archive_bytes, file_count, total_bytes
    FROM registry_resource_archives
    WHERE resource_id = ${release.resourceId} AND sha256 = ${release.newSha256}
  `;
  if (row && !matchesArchive(row, release, current)) {
    throw new Error(
      `${release.slug}: immutable registry archive metadata conflicts`,
    );
  }
  return Boolean(row);
}

export async function registerRegistryArchive(sql, release, current) {
  if (await verifyRegistryArchive(sql, release, current)) return;
  await sql`
    INSERT INTO registry_resource_archives
      (resource_id, sha256, archive_bytes, version_id, file_count, total_bytes)
    SELECT ${release.resourceId}, ${release.newSha256}, ${current.archiveSize},
      ${release.newVersionId}, ${current.pkg.fileCount}, ${current.pkg.totalSize}
    WHERE EXISTS (
      SELECT 1 FROM storages WHERE id = ${release.storageId}
        AND name = ${current.storage.name} AND s3_prefix = ${current.storage.s3_prefix}
        AND xmin::text = ${current.storage.xmin}
        AND head_version_id = ${current.previousVersionId}
    )
    ON CONFLICT (resource_id, sha256) DO NOTHING
  `;
  if (!(await verifyRegistryArchive(sql, release, current))) {
    throw new Error(
      `${release.slug}: source changed before registry archive registration`,
    );
  }
}

export async function publishRegistryHead(sql, release, current) {
  if (current.registryHead.sha256 !== release.newSha256) {
    await sql`
      UPDATE registry_resource_heads h SET sha256 = ${release.newSha256}, updated_at = now()
      WHERE h.resource_id = ${release.resourceId}
        AND h.sha256 = ${current.registryHead.sha256}
        AND h.xmin::text = ${current.registryHead.xmin}
        AND EXISTS (
          SELECT 1 FROM storages s JOIN storage_versions v ON v.storage_id = s.id
          WHERE s.id = ${release.storageId} AND s.name = ${current.storage.name}
            AND s.s3_prefix = ${current.storage.s3_prefix}
            AND s.xmin::text = ${current.publishedStorageXmin}
            AND s.head_version_id = ${release.newVersionId} AND v.id = s.head_version_id
            AND v.s3_key = ${current.s3Key} AND v.archive_size = ${current.archiveSize}
            AND v.size = ${current.pkg.totalSize} AND v.file_count = ${current.pkg.fileCount}
        )
    `;
  }
  await verifyRegistryPublication(sql, release, current);
}

export async function verifyRegistryPublication(sql, release, current) {
  if (!(await verifyRegistryArchive(sql, release, current))) {
    throw new Error(`${release.slug}: registry archive index is missing`);
  }
  const [head] = await sql`
    SELECT h.sha256 FROM registry_resource_heads h
    JOIN storages s ON s.id = ${release.storageId}
    WHERE h.resource_id = ${release.resourceId}
      AND s.name = ${current.storage.name} AND s.s3_prefix = ${current.storage.s3_prefix}
      AND s.xmin::text = ${current.publishedStorageXmin}
      AND s.head_version_id = ${release.newVersionId}
  `;
  if (head?.sha256 !== release.newSha256) {
    throw new Error(
      `${release.slug}: registry HEAD publication conflicted with another writer`,
    );
  }
}
