import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const historicalFixture = `
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
  `;
const migration = await readFile(
  new URL(
    "../src/migrations/1323_detach_file_run_provenance.sql",
    import.meta.url,
  ),
  "utf8",
);

// This case owns temporarily committed historical tables in the same disposable
// test database. Close its session before the positive transaction starts.
const negativeClient = new Client({ connectionString: databaseUrl });
const negativeSchema = `file_provenance_rejection_${randomUUID().replaceAll("-", "")}`;
let negativeSchemaCreated = false;
const negativeErrors: unknown[] = [];
try {
  await negativeClient.connect();
  assert.deepEqual(
    (
      await negativeClient.query(
        "SELECT nspname FROM pg_namespace WHERE nspname = $1",
        [negativeSchema],
      )
    ).rows,
    [],
  );
  await negativeClient.query(`CREATE SCHEMA "${negativeSchema}"`);
  negativeSchemaCreated = true;
  await negativeClient.query(`SET search_path TO "${negativeSchema}"`);
  await negativeClient.query(historicalFixture);
  const runId = randomUUID();
  const threadId = randomUUID();
  const fileId = randomUUID();
  await negativeClient.query("INSERT INTO chat_threads VALUES ($1)", [
    threadId,
  ]);
  await negativeClient.query(
    "INSERT INTO agent_runs VALUES ($1, $2, 'file-org', 'web')",
    [runId, threadId],
  );
  await negativeClient.query(
    "INSERT INTO run_uploaded_files VALUES ($1, $2, NULL, NULL, 'file-owner', 'web', 'stable-write-key', 'retained-url')",
    [fileId, runId],
  );
  for (const kind of ["image", "video", "delivery", "pending-catalog"]) {
    await negativeClient.query(
      "INSERT INTO owned_file_children VALUES ($1, $2, $3)",
      [randomUUID(), fileId, kind],
    );
  }
  await negativeClient.query("INSERT INTO artifacts VALUES ($1, $2)", [
    randomUUID(),
    fileId,
  ]);

  const fixtureTables = [
    ["chat_threads", 1],
    ["agent_runs", 1],
    ["run_uploaded_files", 1],
    ["owned_file_children", 4],
    ["artifacts", 1],
  ] as const;
  const beforeRows = [];
  for (const [table, expectedCount] of fixtureTables) {
    const result = await negativeClient.query(
      `SELECT * FROM "${table}" ORDER BY id`,
    );
    assert.equal(result.rowCount, expectedCount);
    beforeRows.push(result.rows);
  }
  const constraintQuery = `
    SELECT oid, conname, conrelid::regclass::text AS table_name,
           pg_get_constraintdef(oid) AS definition, convalidated
    FROM pg_constraint
    WHERE connamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1)
    ORDER BY conrelid::regclass::text, conname
  `;
  const beforeConstraints = await negativeClient.query(constraintQuery, [
    negativeSchema,
  ]);
  assert.equal(
    beforeConstraints.rows.filter((row) => {
      return (
        row.conname === "run_uploaded_files_run_id_agent_runs_id_fk" &&
        row.definition ===
          "FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE" &&
        row.convalidated === true
      );
    }).length,
    1,
  );
  // One parameterless simple-query request retains the shipped LOCK/guard/drop
  // implicit request transaction; splitting its statements changes the contract.
  await assert.rejects(negativeClient.query(migration), {
    code: "P0001",
    message:
      "Reconcile run-backed file thread/org associations before detaching Run provenance",
  });
  for (const [index, [table]] of fixtureTables.entries()) {
    assert.deepEqual(
      (await negativeClient.query(`SELECT * FROM "${table}" ORDER BY id`)).rows,
      beforeRows[index],
    );
  }
  assert.deepEqual(
    (await negativeClient.query(constraintQuery, [negativeSchema])).rows,
    beforeConstraints.rows,
  );
} catch (error) {
  negativeErrors.push(error);
} finally {
  try {
    // Namespace ownership does not depend on root/child rows or setup completion.
    // A lost CREATE acknowledgement remains uncertain until test DB disposal.
    if (negativeSchemaCreated) {
      await negativeClient.query(`DROP SCHEMA "${negativeSchema}" CASCADE`);
      assert.deepEqual(
        (
          await negativeClient.query(
            "SELECT nspname FROM pg_namespace WHERE nspname = $1",
            [negativeSchema],
          )
        ).rows,
        [],
      );
    }
  } catch (error) {
    negativeErrors.push(error);
  } finally {
    try {
      await negativeClient.end();
    } catch (error) {
      negativeErrors.push(error);
    }
  }
}
if (negativeErrors.length > 0) {
  throw new AggregateError(
    negativeErrors,
    "File provenance rejection probe failed",
  );
}

const client = new Client({ connectionString: databaseUrl });
const schema = `file_provenance_${randomUUID().replaceAll("-", "")}`;

const positiveErrors: unknown[] = [];
try {
  await client.connect();
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0386; new non-billing transactions are prohibited.
  await client.query("BEGIN");
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET LOCAL search_path TO "${schema}"`);
  await client.query(historicalFixture);
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
} catch (error) {
  positiveErrors.push(error);
} finally {
  try {
    await client.query("ROLLBACK");
  } catch (error) {
    positiveErrors.push(error);
  } finally {
    try {
      await client.end();
    } catch (error) {
      positiveErrors.push(error);
    }
  }
}
if (positiveErrors.length > 0) {
  throw new AggregateError(
    positiveErrors,
    "File provenance positive probe failed",
  );
}
