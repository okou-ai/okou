import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const client = new Client({ connectionString: databaseUrl });
await client.connect();
const schema = `file_threads_${randomUUID().replaceAll("-", "")}`;

try {
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0390; new non-billing transactions are prohibited.
  await client.query("BEGIN");
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET LOCAL search_path TO "${schema}"`);
  await client.query(`
    CREATE TABLE agent_runs (
      id uuid PRIMARY KEY,
      chat_thread_id uuid,
      org_id text NOT NULL,
      trigger_source text
    );
    CREATE TABLE run_uploaded_files (
      id uuid PRIMARY KEY,
      run_id uuid,
      chat_thread_id uuid,
      org_id text,
      user_id text NOT NULL,
      url text NOT NULL
    );
  `);
  const runId = randomUUID();
  const threadId = randomUUID();
  const retainedThreadId = randomUUID();
  const orgId = `org_${randomUUID()}`;
  await client.query("INSERT INTO agent_runs VALUES ($1, $2, $3, 'web')", [
    runId,
    threadId,
    orgId,
  ]);
  // More than two keyset batches; aged files must not need retained hot events.
  await client.query(
    `INSERT INTO run_uploaded_files
     SELECT md5('historical-file-' || n)::uuid, $1, NULL, NULL,
            'file-owner', 'https://example.test/report-' || n
     FROM generate_series(1, 2005) n`,
    [runId],
  );
  await client.query(
    "INSERT INTO run_uploaded_files VALUES ('00000000-0000-0000-0000-000000000000', $1, NULL, NULL, 'file-owner', 'https://example.test/report-zero')",
    [runId],
  );
  const retainedFileId = randomUUID();
  await client.query(
    "INSERT INTO run_uploaded_files VALUES ($1, $2, $3, 'retained-org', 'retained-owner', 'retained-url')",
    [retainedFileId, runId, retainedThreadId],
  );
  const unrelatedFileId = randomUUID();
  await client.query(
    "INSERT INTO run_uploaded_files VALUES ($1, NULL, NULL, NULL, 'draft-owner', 'draft-url')",
    [unrelatedFileId],
  );
  const threadlessRunId = randomUUID();
  const threadlessFileId = randomUUID();
  await client.query(
    "INSERT INTO agent_runs VALUES ($1, NULL, 'threadless-org', NULL)",
    [threadlessRunId],
  );
  await client.query(
    "INSERT INTO run_uploaded_files VALUES ($1, $2, NULL, NULL, 'cli-owner', 'cli-url')",
    [threadlessFileId, threadlessRunId],
  );

  const migration = await readFile(
    new URL(
      "../src/migrations/1322_backfill_file_thread_associations.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await client.query(migration);
  const first = await client.query(
    "SELECT * FROM run_uploaded_files ORDER BY id",
  );
  const historical = first.rows.filter((row) => {
    return row.user_id === "file-owner";
  });
  assert.equal(historical.length, 2006);
  for (const row of historical) {
    assert.equal(row.chat_thread_id, threadId);
    assert.equal(row.org_id, orgId);
    assert.equal(row.run_id, runId);
    assert.match(row.url, /^https:\/\/example.test\/report-/);
  }
  assert.deepEqual(
    first.rows.find((row) => {
      return row.id === retainedFileId;
    }),
    {
      id: retainedFileId,
      run_id: runId,
      chat_thread_id: retainedThreadId,
      org_id: "retained-org",
      user_id: "retained-owner",
      url: "retained-url",
    },
  );
  for (const id of [unrelatedFileId, threadlessFileId]) {
    const row = first.rows.find((entry) => {
      return entry.id === id;
    });
    assert.equal(row?.chat_thread_id, null);
    assert.equal(row?.org_id, null);
  }
  await client.query(migration);
  const second = await client.query(
    "SELECT * FROM run_uploaded_files ORDER BY id",
  );
  assert.deepEqual(second.rows, first.rows);
  console.log(
    "File thread backfill: batches, preservation and idempotency passed",
  );
} finally {
  await client.query("ROLLBACK");
  await client.end();
}
