import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Client } from "pg";
import { z } from "zod";

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
// test database. Close its session before the positive probe starts.
const negativeClient = new Client({ connectionString: databaseUrl });
const negativeSchema = `file_provenance_rejection_${randomUUID().replaceAll("-", "")}`;
let negativeSchemaCreated = false;
const negativeErrors: unknown[] = [];
const negativeErrorOccurrences: {
  stage: string;
  observation: string;
  error: unknown;
}[] = [];
let negativeStage = "connect";
// Auth helpers can emit without settling connect. Observe this reject-only
// signal before connecting; cleanup must never race an already rejected signal.
const negativeClientErrorSignal = new Promise<never>((_resolve, reject) => {
  negativeClient.on("error", (error: Error) => {
    negativeErrors.push(error);
    negativeErrorOccurrences.push({
      stage: negativeStage,
      observation: "client error event",
      error,
    });
    reject(error);
  });
});
void negativeClientErrorSignal.catch(() => {});
try {
  const negativeConnect = negativeClient.connect();
  // Keep observing a losing rejection without waiting for event-only auth to
  // settle the original connect promise.
  void negativeConnect.catch((error: unknown) => {
    negativeErrors.push(error);
    negativeErrorOccurrences.push({
      stage: "connect",
      observation: "connect rejection",
      error,
    });
  });
  await Promise.race([negativeConnect, negativeClientErrorSignal]);
  if (negativeErrors.length > 0) throw negativeErrors[0];
  negativeStage = "namespace preflight";
  const namespace = await negativeClient.query(
    "SELECT nspname FROM pg_namespace WHERE nspname = $1",
    [negativeSchema],
  );
  if (negativeErrors.length > 0) throw negativeErrors[0];
  assert.deepEqual(namespace.rows, []);
  negativeStage = "create schema";
  await negativeClient.query(`CREATE SCHEMA "${negativeSchema}"`);
  negativeSchemaCreated = true;
  if (negativeErrors.length > 0) throw negativeErrors[0];
  negativeStage = "search path";
  await negativeClient.query(`SET search_path TO "${negativeSchema}"`);
  if (negativeErrors.length > 0) throw negativeErrors[0];
  negativeStage = "historical fixture";
  await negativeClient.query(historicalFixture);
  if (negativeErrors.length > 0) throw negativeErrors[0];
  const runId = randomUUID();
  const threadId = randomUUID();
  const fileId = randomUUID();
  negativeStage = "insert thread";
  await negativeClient.query("INSERT INTO chat_threads VALUES ($1)", [
    threadId,
  ]);
  if (negativeErrors.length > 0) throw negativeErrors[0];
  negativeStage = "insert run";
  await negativeClient.query(
    "INSERT INTO agent_runs VALUES ($1, $2, 'file-org', 'web')",
    [runId, threadId],
  );
  if (negativeErrors.length > 0) throw negativeErrors[0];
  negativeStage = "insert file";
  await negativeClient.query(
    "INSERT INTO run_uploaded_files VALUES ($1, $2, NULL, NULL, 'file-owner', 'web', 'stable-write-key', 'retained-url')",
    [fileId, runId],
  );
  if (negativeErrors.length > 0) throw negativeErrors[0];
  for (const kind of ["image", "video", "delivery", "pending-catalog"]) {
    negativeStage = `insert child ${kind}`;
    await negativeClient.query(
      "INSERT INTO owned_file_children VALUES ($1, $2, $3)",
      [randomUUID(), fileId, kind],
    );
    if (negativeErrors.length > 0) throw negativeErrors[0];
  }
  negativeStage = "insert artifact";
  await negativeClient.query("INSERT INTO artifacts VALUES ($1, $2)", [
    randomUUID(),
    fileId,
  ]);
  if (negativeErrors.length > 0) throw negativeErrors[0];

  const fixtureTables = [
    ["chat_threads", 1],
    ["agent_runs", 1],
    ["run_uploaded_files", 1],
    ["owned_file_children", 4],
    ["artifacts", 1],
  ] as const;
  const beforeRows = [];
  for (const [table, expectedCount] of fixtureTables) {
    negativeStage = `before rows ${table}`;
    const result = await negativeClient.query(
      `SELECT * FROM "${table}" ORDER BY id`,
    );
    if (negativeErrors.length > 0) throw negativeErrors[0];
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
  negativeStage = "before constraints";
  const beforeConstraints = await negativeClient.query(constraintQuery, [
    negativeSchema,
  ]);
  if (negativeErrors.length > 0) throw negativeErrors[0];
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
  negativeStage = "migration rejection assertion";
  let migrationError: unknown;
  try {
    await assert.rejects(
      negativeClient.query(migration).catch((error: unknown) => {
        migrationError = error;
        throw error;
      }),
      {
        code: "P0001",
        message:
          "Reconcile run-backed file thread/org associations before detaching Run provenance",
      },
    );
  } catch (error) {
    // Preserve the real failed assertion and its wrong native rejection. An
    // unexpected successful query has no fabricated native cause or SQLSTATE.
    if (migrationError !== undefined) {
      negativeErrors.push(migrationError);
      negativeErrorOccurrences.push({
        stage: negativeStage,
        observation: "unexpected migration query rejection",
        error: migrationError,
      });
      if (error instanceof Error) {
        Object.defineProperty(error, "cause", { value: migrationError });
      }
    }
    throw error;
  }
  if (negativeErrors.length > 0) throw negativeErrors[0];
  for (const [index, [table]] of fixtureTables.entries()) {
    negativeStage = `after rows ${table}`;
    const result = await negativeClient.query(
      `SELECT * FROM "${table}" ORDER BY id`,
    );
    if (negativeErrors.length > 0) throw negativeErrors[0];
    assert.deepEqual(result.rows, beforeRows[index]);
  }
  negativeStage = "after constraints";
  const afterConstraints = await negativeClient.query(constraintQuery, [
    negativeSchema,
  ]);
  if (negativeErrors.length > 0) throw negativeErrors[0];
  assert.deepEqual(afterConstraints.rows, beforeConstraints.rows);
} catch (error) {
  negativeErrors.push(error);
  negativeErrorOccurrences.push({
    stage: negativeStage,
    observation: "body rejection",
    error,
  });
} finally {
  // Namespace ownership does not depend on root/child rows or setup completion.
  // A lost CREATE acknowledgement remains uncertain until test DB disposal.
  if (negativeSchemaCreated) {
    negativeStage = "drop schema";
    try {
      await negativeClient.query(`DROP SCHEMA "${negativeSchema}" CASCADE`);
    } catch (error) {
      negativeErrors.push(error);
      negativeErrorOccurrences.push({
        stage: negativeStage,
        observation: "cleanup rejection",
        error,
      });
    }
    negativeStage = "namespace absence";
    try {
      assert.deepEqual(
        (
          await negativeClient.query(
            "SELECT nspname FROM pg_namespace WHERE nspname = $1",
            [negativeSchema],
          )
        ).rows,
        [],
      );
    } catch (error) {
      negativeErrors.push(error);
      negativeErrorOccurrences.push({
        stage: negativeStage,
        observation: "cleanup rejection",
        error,
      });
    }
  }
  negativeStage = "end";
  try {
    await negativeClient.end();
  } catch (error) {
    negativeErrors.push(error);
    negativeErrorOccurrences.push({
      stage: negativeStage,
      observation: "end rejection",
      error,
    });
  }
}
if (negativeErrors.length > 0) {
  throw Object.assign(
    new AggregateError(
      [...new Set(negativeErrors)],
      "File provenance rejection probe failed",
      { cause: negativeErrors[0] },
    ),
    { occurrences: negativeErrorOccurrences },
  );
}

const client = new Client({ connectionString: databaseUrl });
const schema = `file_provenance_${randomUUID().replaceAll("-", "")}`;

const positiveErrors: unknown[] = [];
const recordPositiveClientError = (error: Error) => {
  positiveErrors.push(error);
};
client.on("error", recordPositiveClientError);
const searchPathRows = z.tuple([z.strictObject({ search_path: z.string() })]);
const namespaceRows = z.array(z.strictObject({ nspname: z.string() }));
let originalSearchPath: string | undefined;
let schemaCreated = false;
try {
  await client.connect();
  originalSearchPath = searchPathRows.parse(
    (await client.query("SHOW search_path")).rows,
  )[0].search_path;
  assert.deepEqual(
    namespaceRows.parse(
      (
        await client.query(
          "SELECT nspname FROM pg_namespace WHERE nspname = $1",
          [schema],
        )
      ).rows,
    ),
    [],
  );
  await client.query(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  await client.query(`SET search_path TO "${schema}"`);
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
} catch (error) {
  positiveErrors.push(error);
} finally {
  // Only an acknowledged CREATE owns cleanup. Uncertain acknowledgement or
  // transport loss can leave committed residue until disposable DB teardown.
  if (schemaCreated) {
    try {
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    } catch (error) {
      positiveErrors.push(error);
    }
    try {
      assert.deepEqual(
        namespaceRows.parse(
          (
            await client.query(
              "SELECT nspname FROM pg_namespace WHERE nspname = $1",
              [schema],
            )
          ).rows,
        ),
        [],
      );
    } catch (error) {
      positiveErrors.push(error);
    }
  }
  if (originalSearchPath !== undefined) {
    try {
      await client.query("SELECT set_config('search_path', $1, false)", [
        originalSearchPath,
      ]);
    } catch (error) {
      positiveErrors.push(error);
    }
    try {
      assert.equal(
        searchPathRows.parse((await client.query("SHOW search_path")).rows)[0]
          .search_path,
        originalSearchPath,
      );
    } catch (error) {
      positiveErrors.push(error);
    }
  }
  try {
    await client.end();
  } catch (error) {
    positiveErrors.push(error);
  } finally {
    client.removeListener("error", recordPositiveClientError);
  }
}
if (positiveErrors.length > 0) {
  throw new AggregateError(
    positiveErrors,
    "File provenance positive probe failed",
  );
}
console.log(
  "File provenance: association guard, Run/thread retention, stable upserts and file-owned cleanup passed",
);
