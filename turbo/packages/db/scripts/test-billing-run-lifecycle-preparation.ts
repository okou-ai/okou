import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import postgres from "postgres";
import { z } from "zod";
import { applyPendingMigrations } from "./migration-runner";
import { validateBillingRunLifecycle } from "./test-billing-run-lifecycle-permanent";

// Retain through preparation deployment, outgoing-writer drain and reader cutover (#37796).
const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const admin = new Client({ connectionString: databaseUrl });
await admin.connect();
const databaseName = `billing_lifecycle_${randomUUID().replaceAll("-", "")}`;
await admin.query(`CREATE DATABASE "${databaseName}"`);
const url = new URL(databaseUrl);
url.pathname = `/${databaseName}`;
const migrationClient = postgres(url.toString(), {
  max: 1,
  onnotice: () => {},
});
const client = new Client({ connectionString: url.toString() });
try {
  const journal = z
    .object({
      entries: z.array(z.object({ tag: z.string(), when: z.number() })),
    })
    .parse(
      JSON.parse(
        await readFile(
          new URL("../src/migrations/meta/_journal.json", import.meta.url),
          "utf8",
        ),
      ),
    );
  const entry = journal.entries.find((item) => {
    return item.tag.endsWith("_prepare_billing_run_lifecycle");
  });
  assert.ok(entry);
  await applyPendingMigrations(migrationClient, { beforeMillis: entry.when });
  await client.connect();
  const id = randomUUID();
  const outgoingInsert = `INSERT INTO billing_run_attribution
    (run_id, org_id, user_id, run_started_at, source, thread_id, thread_context)
    VALUES ($1, 'lifecycle-old-org', 'lifecycle-old-user', '2026-10-19 00:00:00.123456', 'chat', NULL, 'unknown')`;
  await client.query(outgoingInsert, [id]);
  const before = await client.query(
    "SELECT to_jsonb(a)::text AS fact FROM billing_run_attribution a WHERE run_id = $1",
    [id],
  );
  await applyPendingMigrations(migrationClient, {
    beforeMillis: entry.when + 1,
  });
  const after = await client.query(
    `SELECT (to_jsonb(a) - ARRAY['run_terminal_status', 'run_completed_at', 'run_lifecycle_context'])::text AS fact
    FROM billing_run_attribution a WHERE run_id = $1`,
    [id],
  );
  assert.deepEqual(after.rows, before.rows);
  const columns =
    "run_id, org_id, user_id, run_started_at, source, thread_id, thread_context, usage_observed, captured_at";
  assert.equal(
    (
      await client.query(
        `SELECT ${columns} FROM billing_run_attribution WHERE run_id = $1`,
        [id],
      )
    ).rows.length,
    1,
  );
  // Outgoing INSERT/UPSERT statements remain legal and do not invent lifecycle facts.
  await client.query(
    `${outgoingInsert} ON CONFLICT (run_id) DO UPDATE SET thread_context = EXCLUDED.thread_context RETURNING ${columns}`,
    [id],
  );
  const newOldId = randomUUID();
  await client.query(outgoingInsert, [newOldId]);
  const facts =
    await client.query(`SELECT run_lifecycle_context, run_terminal_status, run_completed_at
    FROM billing_run_attribution ORDER BY run_id`);
  assert.deepEqual(facts.rows, [
    {
      run_lifecycle_context: "unknown",
      run_terminal_status: null,
      run_completed_at: null,
    },
    {
      run_lifecycle_context: "unknown",
      run_terminal_status: null,
      run_completed_at: null,
    },
  ]);
  await validateBillingRunLifecycle(url.toString());
  console.log(
    "Billing lifecycle preparation preserves outgoing SQL and independent completion facts",
  );
} finally {
  await client.end();
  await migrationClient.end();
  await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await admin.end();
}
