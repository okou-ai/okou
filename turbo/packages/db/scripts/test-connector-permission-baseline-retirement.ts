import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { z } from "zod";
import { DRIZZLE_MIGRATE_OUT } from "../drizzle.config";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const journal = z
  .object({ entries: z.array(z.object({ tag: z.string() })) })
  .parse(
    JSON.parse(
      await readFile(`${DRIZZLE_MIGRATE_OUT}/meta/_journal.json`, "utf8"),
    ),
  );
const entry = journal.entries.find((item) => {
  return item.tag.endsWith("_retire_connector_permission_baseline");
});
assert.ok(entry, "Baseline retirement migration must remain in the journal");
const migration = await readFile(
  `${DRIZZLE_MIGRATE_OUT}/${entry.tag}.sql`,
  "utf8",
);
const contexts = [
  {
    connectorRuntimeTargets: [{ kind: "builtin", connectorSlug: "github" }],
    networkPolicies: { github: { allow: ["user:read"], deny: [] } },
    encryptedSecrets: "opaque-test-envelope",
  },
  { connectorRuntimeTargets: [], environment: null },
];
const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0382; new non-billing transactions are prohibited.
  await client.query("BEGIN");
  // A temporary table isolates the transform from every real queued Run.
  await client.query(
    "CREATE TEMP TABLE runner_job_queue (id integer PRIMARY KEY, execution_context jsonb NOT NULL) ON COMMIT DROP",
  );
  const rows = [
    { ...contexts[0], connectorPermissionBaseline: { version: 1 } },
    { ...contexts[1], connectorPermissionBaseline: "malformed" },
    contexts[0],
  ];
  for (const [id, context] of rows.entries()) {
    await client.query("INSERT INTO runner_job_queue VALUES ($1, $2)", [
      id,
      JSON.stringify(context),
    ]);
  }
  const expected = [contexts[0], contexts[1], contexts[0]];
  for (let attempt = 0; attempt < 2; attempt++) {
    await client.query(migration);
    const result = await client.query<{ execution_context: unknown }>(
      "SELECT execution_context FROM runner_job_queue ORDER BY id",
    );
    assert.deepEqual(
      result.rows.map((row) => {
        return row.execution_context;
      }),
      expected,
      "Retirement must preserve other fields and remain idempotent",
    );
  }
  await client.query("ROLLBACK");
} finally {
  await client.end();
}
console.log("Connector permission baseline retirement migration passed");
