import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

import { applyPendingMigrations } from "./migration-runner";

// Exercise PostgreSQL three-valued CHECK semantics against the real journal,
// including the outgoing writer captured by 1078_baseline before the repair.
const directory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../src/migrations",
);
const database = `migration_pi_memory_${randomUUID().replaceAll("-", "")}`;
const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
const testUrl = new URL(databaseUrl);
testUrl.pathname = `/${database}`;
const admin = new Client({ connectionString: adminUrl.toString() });
await admin.connect();
await admin.query(`CREATE DATABASE "${database}"`);
const client = new Client({ connectionString: testUrl.toString() });
await client.connect();
const migrationSql = postgres(testUrl.toString(), { max: 1 });
const originalDirectory = process.cwd();
const fixtureDirectory = await mkdtemp(join(tmpdir(), "pi-memory-migrations-"));
const fixtureMigrations = join(fixtureDirectory, "src/migrations");
const journal = JSON.parse(
  await readFile(join(directory, "meta/_journal.json"), "utf8"),
) as { entries: { idx: number; tag: string; when: number }[] };

async function applyThrough(tag: string) {
  const last = journal.entries.find((entry) => {
    return entry.tag === tag;
  });
  assert.ok(last, `Active Phase 2 transition migration is absent: ${tag}`);
  const entries = journal.entries.filter((entry) => {
    return entry.idx <= last.idx;
  });
  await mkdir(join(fixtureMigrations, "meta"), { recursive: true });
  for (const entry of entries) {
    await copyFile(
      join(directory, `${entry.tag}.sql`),
      join(fixtureMigrations, `${entry.tag}.sql`),
    );
  }
  await writeFile(
    join(fixtureMigrations, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries }),
  );
  // Use the production runner, real migration bytes and its transaction/timeout
  // policy. Only the on-disk journal frontier changes to seed the old DB state.
  process.chdir(fixtureDirectory);
  await applyPendingMigrations(migrationSql);
}

async function seed(shape: "pending" | "legacy" | "sandbox" | "expired") {
  const storageId = randomUUID();
  const token = randomUUID();
  await client.query(
    `INSERT INTO storages (id, org_id, user_id, name, s3_prefix)
    VALUES ($1::uuid, 'migration-org', $1::text, 'memory', $1::text)`,
    [storageId],
  );
  // Keep timestamp-without-time-zone fixtures on the migration's database clock.
  await client.query(
    `INSERT INTO pi_memory_phase2_jobs
    (memory_storage_id, org_id, user_id, status, claimed_revision,
     claimed_base_version_id, lease_token, sandbox_lease_token, lease_expires_at, claimed_selection_digest, claimed_selected_count, claimed_selected_utf8_bytes)
    VALUES ($1::uuid, 'migration-org', $1::text, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP + $7::interval, CASE WHEN $2::varchar = 'leased' THEN repeat('b',64) END, CASE WHEN $2::varchar = 'leased' THEN 0 END, CASE WHEN $2::varchar = 'leased' THEN 0 END)`,
    [
      storageId,
      shape === "pending" ? "pending" : "leased",
      shape === "pending" ? null : 1,
      shape === "pending" ? null : "a".repeat(64),
      shape === "pending" ? null : token,
      shape === "sandbox" ? token : null,
      shape === "pending" ? null : shape === "expired" ? "-1 minute" : "1 hour",
    ],
  );
  return { storageId, token };
}

try {
  await applyThrough("1078_baseline");
  // Same order of magnitude as the refreshed 16,393-parent bound. Only the
  // one exact live legacy row is updated; pending rows are classified intact.
  await client.query(`WITH parents AS (
    INSERT INTO storages (id, org_id, user_id, name, s3_prefix)
    SELECT gen_random_uuid(), 'scale-org', item::text, 'memory', 'scale/' || item
    FROM generate_series(1, 16390) AS item RETURNING id, org_id, user_id
  ) INSERT INTO pi_memory_phase2_jobs (memory_storage_id, org_id, user_id)
    SELECT id, org_id, user_id FROM parents`);
  const pending = await seed("pending");
  const legacy = await seed("legacy");
  const sandbox = await seed("sandbox");
  const expired = await seed("expired");
  // 1077 incorrectly accepts a fresh null/null lease. The repair must classify
  // existing rows and refuse an ambiguous expired lease, atomically.
  await assert.rejects(
    applyThrough("1079_pi_memory_checkpoint_settlement"),
    /requires exact lease classification/,
  );
  assert.equal(
    (
      await client.query(
        "SELECT to_regclass('pi_memory_phase2_checkpoints') AS name",
      )
    ).rows[0].name,
    null,
  );
  // This is a test fixture repair, never a production cleanup prescription.
  await client.query("DELETE FROM storages WHERE id = $1", [expired.storageId]);
  await applyThrough("1079_pi_memory_checkpoint_settlement");
  const rows =
    await client.query(`SELECT memory_storage_id, lease_token, legacy_lease_token, sandbox_lease_token
    FROM pi_memory_phase2_jobs WHERE org_id = 'migration-org' ORDER BY memory_storage_id`);
  assert.equal(rows.rowCount, 3);
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::int AS count FROM pi_memory_phase2_jobs",
      )
    ).rows[0].count,
    16393,
  );
  assert.deepEqual(
    rows.rows.find((row) => {
      return row.memory_storage_id === legacy.storageId;
    }),
    {
      memory_storage_id: legacy.storageId,
      lease_token: legacy.token,
      legacy_lease_token: legacy.token,
      sandbox_lease_token: null,
    },
  );
  assert.equal(
    rows.rows.find((row) => {
      return row.memory_storage_id === sandbox.storageId;
    }).sandbox_lease_token,
    sandbox.token,
  );

  const claim = `UPDATE pi_memory_phase2_jobs SET status = 'leased', claimed_revision = 1,
    claimed_base_version_id = $2, lease_token = $3, sandbox_lease_token = $4, claimed_selection_digest = repeat('b',64), claimed_selected_count = 0, claimed_selected_utf8_bytes = 0,
    lease_expires_at = CURRENT_TIMESTAMP + INTERVAL '1 hour' WHERE memory_storage_id = $1`;
  await assert.rejects(
    client.query(claim, [
      pending.storageId,
      "a".repeat(64),
      randomUUID(),
      null,
    ]),
    /pi_memory_phase2_jobs_execution_fence_check/,
  );
  await assert.rejects(
    client.query(claim, [
      pending.storageId,
      "a".repeat(64),
      randomUUID(),
      randomUUID(),
    ]),
    /pi_memory_phase2_jobs_execution_fence_check/,
  );
  const validToken = randomUUID();
  await client.query(claim, [
    pending.storageId,
    "a".repeat(64),
    validToken,
    validToken,
  ]);
  await assert.rejects(
    client.query(
      "UPDATE pi_memory_phase2_jobs SET lease_token = $2 WHERE memory_storage_id = $1",
      [legacy.storageId, randomUUID()],
    ),
    /pi_memory_phase2_jobs_execution_fence_check/,
  );
  assert.equal(
    (
      await client.query(
        "SELECT lease_token FROM pi_memory_phase2_jobs WHERE memory_storage_id = $1",
        [legacy.storageId],
      )
    ).rows[0].lease_token,
    legacy.token,
  );
  console.log(
    "Phase 2 real migration: unsafe rollout rolls back; live legacy/new claims survive; fresh and mismatched legacy claims fail.",
  );
} finally {
  process.chdir(originalDirectory);
  await migrationSql.end();
  await rm(fixtureDirectory, { recursive: true, force: true });
  await client.end();
  await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
  await admin.end();
}
