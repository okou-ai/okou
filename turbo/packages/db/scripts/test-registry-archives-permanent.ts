import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";

export async function validatePermanentRegistryArchives(databaseUrl: string) {
  const client = new Client({ connectionString: databaseUrl });
  const storageId = randomUUID();
  const prefix = `registry-archive-fixture/${storageId}`;
  const resourceId = `template:html-ppt-fixture-${storageId}-runbook`;
  const otherResourceId = `template:html-ppt-other-${storageId}-runbook`;
  const versionId = createHash("sha256").update(storageId).digest("hex");
  const digest = createHash("sha256").update(prefix).digest("hex");

  await client.connect();
  try {
    await client.query(
      `INSERT INTO storages (id, user_id, org_id, name, s3_prefix)
       VALUES ($1, 'fixture', $2, 'registry-archive-fixture', $2)`,
      [storageId, prefix],
    );
    await client.query(
      `INSERT INTO storage_versions
       (id, storage_id, s3_key, archive_size, size, file_count, created_by)
       VALUES ($1, $2, $3, 1, 1, 1, 'fixture')`,
      [versionId, storageId, `${prefix}/${versionId}`],
    );
    await client.query(
      `INSERT INTO registry_resource_archives
       (resource_id, sha256, version_id, archive_bytes, file_count, total_bytes)
       VALUES ($1, $2, $3, 1, 1, 1)`,
      [resourceId, digest, versionId],
    );

    const insertHead = `INSERT INTO registry_resource_heads (resource_id, sha256)
                        VALUES ($1, $2)`;
    const foreignKeyViolation = {
      code: "23503",
      constraint: "fk_registry_resource_head_archive",
    };
    await assert.rejects(
      client.query(insertHead, [resourceId, "0".repeat(64)]),
      foreignKeyViolation,
    );
    await assert.rejects(
      client.query(insertHead, [otherResourceId, digest]),
      foreignKeyViolation,
    );
    await client.query(insertHead, [resourceId, digest]);

    const deletedVersion = await client.query(
      "DELETE FROM storage_versions WHERE id = $1 AND storage_id = $2",
      [versionId, storageId],
    );
    assert.equal(deletedVersion.rowCount, 1);
    const deletedStorage = await client.query(
      "DELETE FROM storages WHERE id = $1",
      [storageId],
    );
    assert.equal(deletedStorage.rowCount, 1);
    const archive = await client.query(
      `SELECT a.sha256, a.version_id
       FROM registry_resource_archives a
       JOIN registry_resource_heads h USING (resource_id, sha256)
       WHERE a.resource_id = $1`,
      [resourceId],
    );
    assert.deepEqual(archive.rows, [{ sha256: digest, version_id: versionId }]);
    console.log(
      "Registry HEAD scope and archive retention after Storage deletion passed",
    );
  } finally {
    try {
      await client.query(
        "DELETE FROM registry_resource_heads WHERE resource_id IN ($1, $2)",
        [resourceId, otherResourceId],
      );
      await client.query(
        "DELETE FROM registry_resource_archives WHERE resource_id = $1",
        [resourceId],
      );
      await client.query("DELETE FROM storages WHERE id = $1", [storageId]);
    } finally {
      await client.end();
    }
  }
}
