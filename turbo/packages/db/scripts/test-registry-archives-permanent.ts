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
    } finally {
      await client.end();
    }
  }
}
