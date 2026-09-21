import assert from "node:assert/strict";

import { release } from "./bundle.mjs";

const PUBLISHER = "presentation-extract-template-publisher";

export async function loadOwner(sql) {
  const rows = await sql`
    SELECT s.id, s.org_id, s.user_id
    FROM storages s
    JOIN storage_versions v ON v.storage_id = s.id
    WHERE v.id = ${release.ownerAnchorVersionId}
  `;
  if (
    rows.length !== 1 ||
    typeof rows[0].id !== "string" ||
    typeof rows[0].org_id !== "string" ||
    !/^[a-zA-Z0-9_-]+$/u.test(rows[0].org_id) ||
    typeof rows[0].user_id !== "string" ||
    rows[0].user_id.length === 0 ||
    rows[0].id === release.storageId
  ) {
    throw new Error("Authoritative registry owner could not be resolved.");
  }
  return rows[0];
}

export function storageIdentity(owner) {
  return {
    name: `registry-resource@${release.resourceId}`,
    prefix: `${owner.org_id}/${release.storageId}`,
    key: `${owner.org_id}/${release.storageId}/${release.versionId}`,
  };
}

function integer(value) {
  if (typeof value !== "number" && typeof value !== "string") {
    throw new Error("Invalid storage size returned by PostgreSQL.");
  }
  if (typeof value === "string" && !/^\d+$/u.test(value)) {
    throw new Error("Invalid storage size returned by PostgreSQL.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Storage size is outside the safe integer range.");
  }
  return parsed;
}

export async function assertPublicationState(sql, owner, publication) {
  const identity = storageIdentity(owner);
  const storages = await sql`
    SELECT id, org_id, user_id, name, s3_prefix, head_version_id, size, file_count
    FROM storages
    WHERE id = ${release.storageId} OR name = ${identity.name}
  `;
  const versions = await sql`
    SELECT id, storage_id, s3_key, size, archive_size, file_count, message, created_by
    FROM storage_versions
    WHERE id = ${release.versionId} OR storage_id = ${release.storageId}
  `;
  if (storages.length === 0 && versions.length === 0) {
    return false;
  }
  if (storages.length !== 1 || versions.length !== 1) {
    throw new Error("Existing storage or version conflicts with this release.");
  }
  const storage = storages[0];
  assert.deepEqual(
    { ...storage, size: integer(storage.size) },
    {
      id: release.storageId,
      org_id: owner.org_id,
      user_id: owner.user_id,
      name: identity.name,
      s3_prefix: identity.prefix,
      head_version_id: release.versionId,
      size: publication.totalSize,
      file_count: publication.fileCount,
    },
    "Existing storage does not match this release.",
  );
  const version = versions[0];
  assert.deepEqual(
    {
      ...version,
      size: integer(version.size),
      archive_size: integer(version.archive_size),
    },
    {
      id: release.versionId,
      storage_id: release.storageId,
      s3_key: identity.key,
      size: publication.totalSize,
      archive_size: publication.archive.byteSize,
      file_count: publication.fileCount,
      message: `${release.source.repository}@${release.source.commit}`,
      created_by: PUBLISHER,
    },
    "Existing storage version does not match this release.",
  );
  return true;
}

export async function registerPublication(sql, owner, publication) {
  const identity = storageIdentity(owner);
  await sql.begin(async (tx) => {
    // Serialize retries of this dedicated publisher. Unique constraints also
    // reject unrelated concurrent writers instead of replacing their rows.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${release.storageId}, 0))`;
    await tx`SELECT id FROM storages WHERE id = ${owner.id} FOR SHARE`;
    assert.deepEqual(await loadOwner(tx), owner, "Registry owner changed.");
    if (await assertPublicationState(tx, owner, publication)) {
      return;
    }
    await tx`
      INSERT INTO storages (id, org_id, user_id, name, s3_prefix)
      VALUES (${release.storageId}, ${owner.org_id}, ${owner.user_id}, ${identity.name}, ${identity.prefix})
    `;
    await tx`
      INSERT INTO storage_versions
        (id, storage_id, s3_key, size, archive_size, file_count, message, created_by)
      VALUES
        (${release.versionId}, ${release.storageId}, ${identity.key},
         ${publication.totalSize}, ${publication.archive.byteSize}, ${publication.fileCount},
         ${`${release.source.repository}@${release.source.commit}`}, ${PUBLISHER})
    `;
    await tx`
      UPDATE storages
      SET head_version_id = ${release.versionId}, size = ${publication.totalSize},
          file_count = ${publication.fileCount}, updated_at = now()
      WHERE id = ${release.storageId}
    `;
    await assertPublicationState(tx, owner, publication);
  });
  if (!(await assertPublicationState(sql, owner, publication))) {
    throw new Error("Post-publication database verification failed.");
  }
}
