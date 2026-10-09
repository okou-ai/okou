import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { z } from "zod";
import postgres from "postgres";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { DRIZZLE_MIGRATE_OUT } from "../drizzle.config";
import { applyPendingMigrations } from "./migration-runner";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const databaseName = `checkpoint_retirement_${randomUUID().replaceAll("-", "")}`;
const admin = new Client({ connectionString: databaseUrl });
await admin.connect();
const url = new URL(databaseUrl);
url.pathname = `/${databaseName}`;
const journal = z
  .object({ entries: z.array(z.object({ tag: z.string(), when: z.number() })) })
  .parse(
    JSON.parse(
      await readFile(`${DRIZZLE_MIGRATE_OUT}/meta/_journal.json`, "utf8"),
    ),
  );
const entry = journal.entries.find((item) => {
  return item.tag.endsWith("_detach_memory_history_from_run_checkpoints");
});
assert.ok(entry, "Retirement preparation migration must remain until shipped");
const migration = readMigrationFiles({
  migrationsFolder: DRIZZLE_MIGRATE_OUT,
}).find((item) => {
  return item.folderMillis === entry.when;
});
assert.ok(migration);
await admin.query(`CREATE DATABASE "${databaseName}"`);
const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
try {
  await applyPendingMigrations(sql, { beforeMillis: migration.folderMillis });
  const storageId = randomUUID();
  const oldCheckpointId = randomUUID();
  await sql`INSERT INTO storages (id, org_id, user_id, name, s3_prefix) VALUES (${storageId}, 'migration-org', 'migration-user', 'memory', ${storageId})`;
  await sql`INSERT INTO pi_memory_phase2_jobs (memory_storage_id, org_id, user_id, last_maintenance_run_id, last_maintenance_revision, last_maintenance_base_version_id, last_maintenance_selection_digest, last_maintenance_checkpoint_id, last_maintenance_checkpoint_version_id, last_maintenance_outcome)
    VALUES (${storageId}, 'migration-org', 'migration-user', ${randomUUID()}, 1, ${"a".repeat(64)}, ${"b".repeat(64)}, ${oldCheckpointId}, ${"c".repeat(64)}, 'published')`;
  const failWithoutTouchingLegacyId = () => {
    return sql`UPDATE pi_memory_phase2_jobs SET last_maintenance_outcome = 'failed', last_maintenance_checkpoint_version_id = NULL WHERE memory_storage_id = ${storageId}`;
  };
  await assert.rejects(
    failWithoutTouchingLegacyId(),
    /pi_memory_phase2_jobs_maintenance_history_check/,
  );
  await applyPendingMigrations(sql, {
    beforeMillis: migration.folderMillis + 1,
  });
  const preserved =
    await sql`SELECT last_maintenance_checkpoint_id, last_maintenance_outcome FROM pi_memory_phase2_jobs WHERE memory_storage_id = ${storageId}`;
  assert.equal(preserved[0]?.last_maintenance_checkpoint_id, oldCheckpointId);
  assert.equal(preserved[0]?.last_maintenance_outcome, "published");
  await failWithoutTouchingLegacyId();
  const failed =
    await sql`SELECT last_maintenance_checkpoint_id, last_maintenance_outcome FROM pi_memory_phase2_jobs WHERE memory_storage_id = ${storageId}`;
  assert.equal(failed[0]?.last_maintenance_checkpoint_id, oldCheckpointId);
  assert.equal(failed[0]?.last_maintenance_outcome, "failed");
  // The outgoing API may still write its ID after the additive migration.
  await sql`UPDATE pi_memory_phase2_jobs SET last_maintenance_checkpoint_id = ${randomUUID()}, last_maintenance_checkpoint_version_id = ${"d".repeat(64)}, last_maintenance_outcome = 'published' WHERE memory_storage_id = ${storageId}`;
  // The new API's validated no-diff receipt requires a version, never a Run checkpoint ID.
  await sql`UPDATE pi_memory_phase2_jobs SET last_maintenance_checkpoint_id = NULL, last_maintenance_checkpoint_version_id = last_maintenance_base_version_id, last_maintenance_outcome = 'no_diff' WHERE memory_storage_id = ${storageId}`;
  await assert.rejects(
    sql`UPDATE pi_memory_phase2_jobs SET last_maintenance_checkpoint_version_id = NULL WHERE memory_storage_id = ${storageId}`,
    /pi_memory_phase2_jobs_maintenance_history_check/,
  );
  await assert.rejects(
    sql`UPDATE pi_memory_phase2_jobs SET last_maintenance_revision = 0 WHERE memory_storage_id = ${storageId}`,
    /pi_memory_phase2_jobs_maintenance_history_check/,
  );
  await applyPendingMigrations(sql, {
    beforeMillis: migration.folderMillis + 1,
  });
  console.log(
    "Checkpoint retirement preparation preserves historical IDs, accepts outgoing/current writers, and retains publication version and revision constraints.",
  );
} finally {
  await sql.end();
  await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await admin.end();
}
