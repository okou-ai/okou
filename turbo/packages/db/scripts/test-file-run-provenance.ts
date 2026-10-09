import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const client = new Client({ connectionString: databaseUrl });
await client.connect();
const schema = `file_provenance_${randomUUID().replaceAll("-", "")}`;

try {
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0388; new non-billing transactions are prohibited.
  await client.query("BEGIN");
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET LOCAL search_path TO "${schema}"`);
  await client.query(`
    CREATE TABLE chat_threads (id uuid PRIMARY KEY);
    CREATE TABLE agent_runs (
      id uuid PRIMARY KEY,
      chat_thread_id uuid REFERENCES chat_threads(id) ON DELETE SET NULL,
      org_id text NOT NULL,
      trigger_source text
    );
    CREATE TABLE run_uploaded_files (
      id uuid PRIMARY KEY,
      run_id uuid CONSTRAINT run_uploaded_files_run_id_agent_runs_id_fk
        REFERENCES agent_runs(id) ON DELETE CASCADE,
      chat_thread_id uuid REFERENCES chat_threads(id) ON DELETE SET NULL,
      org_id text,
      user_id text NOT NULL,
      source text NOT NULL,
      external_id text NOT NULL,
      url text NOT NULL,
      UNIQUE (run_id, source, external_id)
    );
    CREATE TABLE owned_file_children (
      id uuid PRIMARY KEY,
      file_id uuid NOT NULL REFERENCES run_uploaded_files(id) ON DELETE CASCADE,
      kind text NOT NULL
    );
    CREATE TABLE artifacts (id uuid PRIMARY KEY, projection_file_id uuid NOT NULL);
  `);
  const runId = randomUUID();
  const threadId = randomUUID();
  const fileId = randomUUID();
  await client.query("INSERT INTO chat_threads VALUES ($1)", [threadId]);
  await client.query(
    "INSERT INTO agent_runs VALUES ($1, $2, 'file-org', 'web')",
    [runId, threadId],
  );
  await client.query(
    "INSERT INTO run_uploaded_files VALUES ($1, $2, NULL, NULL, 'file-owner', 'web', 'stable-write-key', 'retained-url')",
    [fileId, runId],
  );
  for (const kind of ["image", "video", "delivery", "pending-catalog"]) {
    await client.query("INSERT INTO owned_file_children VALUES ($1, $2, $3)", [
      randomUUID(),
      fileId,
      kind,
    ]);
  }
  await client.query("INSERT INTO artifacts VALUES ($1, $2)", [
    randomUUID(),
    fileId,
  ]);
  const migration = await readFile(
    new URL(
      "../src/migrations/1323_detach_file_run_provenance.sql",
      import.meta.url,
    ),
    "utf8",
  );
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0389; new non-billing transactions are prohibited.
  await client.query("SAVEPOINT missing_association");
  await assert.rejects(client.query(migration), { code: "P0001" });
  await client.query("ROLLBACK TO SAVEPOINT missing_association");
  await client.query(
    "UPDATE run_uploaded_files SET chat_thread_id = $1, org_id = 'file-org' WHERE id = $2",
    [threadId, fileId],
  );
  const original = await client.query(
    "SELECT * FROM run_uploaded_files ORDER BY id",
  );
  await client.query(migration);
  assert.deepEqual(
    (await client.query("SELECT * FROM run_uploaded_files ORDER BY id")).rows,
    original.rows,
  );
  await client.query("DELETE FROM agent_runs WHERE id = $1", [runId]);
  assert.deepEqual(
    (await client.query("SELECT * FROM run_uploaded_files ORDER BY id")).rows,
    original.rows,
  );
  assert.equal(
    (await client.query("SELECT * FROM owned_file_children")).rowCount,
    4,
  );
  assert.equal((await client.query("SELECT * FROM artifacts")).rowCount, 1);
  await client.query(
    `INSERT INTO run_uploaded_files VALUES ($1, $2, $3, 'file-org', 'file-owner', 'web', 'stable-write-key', 'updated-url')
     ON CONFLICT (run_id, source, external_id) DO UPDATE SET url = EXCLUDED.url`,
    [randomUUID(), runId, threadId],
  );
  const upserted = await client.query("SELECT * FROM run_uploaded_files");
  assert.equal(upserted.rowCount, 1);
  assert.equal(upserted.rows[0]?.id, fileId);
  assert.equal(upserted.rows[0]?.run_id, runId);
  assert.equal(upserted.rows[0]?.url, "updated-url");
  await client.query("DELETE FROM chat_threads WHERE id = $1", [threadId]);
  const detached = await client.query("SELECT * FROM run_uploaded_files");
  assert.equal(detached.rows[0]?.chat_thread_id, null);
  assert.equal(detached.rows[0]?.user_id, "file-owner");
  assert.equal(detached.rows[0]?.org_id, "file-org");
  assert.equal(detached.rows[0]?.run_id, runId);
  assert.equal(
    (await client.query("SELECT * FROM owned_file_children")).rowCount,
    4,
  );
  assert.equal((await client.query("SELECT * FROM artifacts")).rowCount, 1);
  await client.query("DELETE FROM run_uploaded_files WHERE id = $1", [fileId]);
  assert.equal(
    (await client.query("SELECT * FROM owned_file_children")).rowCount,
    0,
  );
  console.log(
    "File provenance: association guard, Run/thread retention, stable upserts and file-owned cleanup passed",
  );
} finally {
  await client.query("ROLLBACK");
  await client.end();
}
