import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { applyPendingMigrations } from "./migration-runner";

export async function validatePiResourceIndexRetirement(
  databaseUrl: string,
  migrationMillis: number,
): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  const root = randomUUID();
  const parent = randomBytes(32).toString("hex");
  const child = randomBytes(32).toString("hex");
  const run = randomUUID();
  const retire = () => {
    return applyPendingMigrations(sql, { beforeMillis: migrationMillis + 1 });
  };
  try {
    await applyPendingMigrations(sql, { beforeMillis: migrationMillis });
    await sql`INSERT INTO storages (id, org_id, user_id, name, s3_prefix)
      VALUES (${root}, 'pi-index-test', 'owner', 'memory', 'fixture')`;
    await sql`INSERT INTO storage_versions (id, storage_id, s3_key, archive_size, created_by)
      VALUES (${parent}, ${root}, 'parent', 10, 'owner'), (${child}, ${root}, 'child', 10, 'owner')`;
    await sql`INSERT INTO storage_version_lineage (storage_id, version_id, parent_version_id, run_id)
      VALUES (${root}, ${child}, ${parent}, ${run})`;
    await sql`INSERT INTO pi_resource_version_indexes
      (storage_version_id, extractor_version, status, projection, projection_hash, source_archive_size)
      VALUES (${parent}, 1, 'ready', '{}', ${parent}, 10), (${child}, 1, 'pending', NULL, NULL, NULL)`;

    const unfinished = { code: "P0001", message: /unfinished or leased/ };
    await assert.rejects(retire, unfinished);
    await sql`UPDATE pi_resource_version_indexes
      SET status = 'running', lease_id = gen_random_uuid(), lease_expires_at = now() + interval '1 hour'
      WHERE storage_version_id = ${child}`;
    await assert.rejects(retire, unfinished);
    await sql`UPDATE pi_resource_version_indexes
      SET status = 'unindexable', lease_id = NULL, lease_expires_at = NULL
      WHERE storage_version_id = ${child}`;

    await sql`CREATE VIEW pi_index_consumer_fixture AS SELECT status FROM pi_resource_version_indexes`;
    await assert.rejects(retire, { code: "2BP01" });
    await sql`DROP VIEW pi_index_consumer_fixture`;
    await retire();

    assert.deepEqual(
      Array.from(
        await sql`SELECT to_regclass('public.pi_resource_version_indexes') AS relation`,
      ),
      [{ relation: null }],
    );
    assert.deepEqual(
      Array.from(
        await sql`SELECT child.id AS child, parent.id AS parent, lineage.run_id
        FROM storage_version_lineage AS lineage
        JOIN storage_versions AS child ON child.id = lineage.version_id AND child.storage_id = lineage.storage_id
        JOIN storage_versions AS parent ON parent.id = lineage.parent_version_id AND parent.storage_id = lineage.storage_id
        WHERE lineage.storage_id = ${root}`,
      ),
      [{ child, parent, run_id: run }],
    );
    await sql`DELETE FROM storages WHERE id = ${root}`;
  } finally {
    await sql.end();
  }
}
