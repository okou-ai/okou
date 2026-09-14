import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "pg";

// Schema-transition and operator-CLI contracts cannot be constructed through a
// product API: A1 intentionally has no consumer endpoint or deletion activation.
const execute = promisify(execFile);
const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const schema = `billing_${randomUUID().replaceAll("-", "")}`;
const client = new Client({ connectionString: databaseUrl });
await client.connect();
const scopedUrl = new URL(databaseUrl);
scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
async function migrate(name: string) {
  await client.query(
    await readFile(
      new URL(`../src/migrations/${name}.sql`, import.meta.url),
      "utf8",
    ),
  );
}
async function cli(args: string[]) {
  const { stdout } = await execute(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/billing-attribution.ts",
      "--org-id",
      "org",
      ...args,
    ],
    {
      env: { ...process.env, DATABASE_URL: scopedUrl.toString() },
    },
  );
  const value: unknown = JSON.parse(stdout);
  assert.ok(value !== null && typeof value === "object");
  return Object.fromEntries(Object.entries(value));
}
async function rejects(query: string, args: unknown[] = []) {
  await assert.rejects(client.query(query, args), { code: "23514" });
}
const run = randomUUID();
const rollupRun = randomUUID();
const pending = randomUUID();
const newRun = randomUUID();
const late = randomUUID();
const missing = randomUUID();
try {
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}"`);
  await client.query(`
    CREATE TABLE agent_runs (id uuid PRIMARY KEY, org_id text NOT NULL, user_id text NOT NULL, created_at timestamp NOT NULL, trigger_source text, prompt text);
    CREATE TABLE usage_event (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid REFERENCES agent_runs ON DELETE SET NULL,
      org_id text NOT NULL, user_id text NOT NULL, idempotency_key uuid UNIQUE DEFAULT gen_random_uuid(), created_at timestamp DEFAULT now(),
      status text DEFAULT 'pending', quantity bigint DEFAULT 0, credits_charged bigint, processed_at timestamp);
    CREATE TABLE usage_event_hourly_rollup (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid REFERENCES agent_runs ON DELETE SET NULL,
      org_id text NOT NULL, user_id text NOT NULL, processed_hour timestamp, quantity bigint, credits_charged bigint, allowance_units bigint);
    CREATE TABLE built_in_generation_jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid REFERENCES agent_runs ON DELETE SET NULL,
      org_id text NOT NULL, user_id text NOT NULL, status text DEFAULT 'running');
    CREATE TABLE usage_allowance_allocations (run_id uuid);
    CREATE TABLE org_usage_allowance_windows (created_by_run_id uuid);
  `);
  await client.query(
    "INSERT INTO agent_runs VALUES ($1, 'org', 'user', '2026-08-01 23:59:00', 'web', 'private'), ($2, 'org', 'user', '2026-08-01 20:00:00', 'automation-event', 'private')",
    [run, rollupRun],
  );
  await client.query(
    "INSERT INTO usage_event (id, run_id, org_id, user_id, created_at, quantity) VALUES ($1, $2, 'org', 'user', '2026-08-02 00:01:00', 9), ($3, NULL, 'org', 'user', '2026-08-02 00:01:00', 7)",
    [pending, run, missing],
  );
  await client.query(
    "INSERT INTO usage_event_hourly_rollup (run_id, org_id, user_id, processed_hour, quantity, credits_charged, allowance_units) VALUES ($1, 'org', 'user', '2026-08-02', 9007199254740993, 100, 23)",
    [rollupRun],
  );
  await migrate("1117_billing_run_attribution");
  await migrate("1118_billing_attribution_capture");

  // Both a legacy INSERT RETURNING and the canonical data-modifying CTE capture
  // the same minimal identity in the transaction that publishes the run.
  await client.query(
    "WITH inserted_run AS (INSERT INTO agent_runs VALUES ($1, 'org', 'user', '2026-08-03 23:59:00', 'web', 'do not retain') RETURNING id) SELECT id FROM inserted_run",
    [newRun],
  );
  await client.query(
    "INSERT INTO usage_event (id, run_id, org_id, user_id, created_at, quantity) VALUES ($1, $2, 'org', 'user', '2026-08-04 00:01:00', 11) ON CONFLICT (id) DO NOTHING RETURNING id",
    [late, newRun],
  );
  await client.query(
    "INSERT INTO usage_event (id, run_id, org_id, user_id, created_at, quantity) VALUES ($1, $2, 'org', 'user', '2026-08-04 00:01:00', 11) ON CONFLICT (id) DO NOTHING RETURNING id",
    [late, newRun],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT billing_run_id, billing_anchor_at::text, billing_context, quantity::text FROM usage_event WHERE id=$1",
        [late],
      )
    ).rows,
    [
      {
        billing_run_id: newRun,
        billing_anchor_at: "2026-08-03 23:59:00",
        billing_context: "run",
        quantity: "11",
      },
    ],
  );
  await rejects(
    "SELECT ensure_billing_run_attribution($1, 'other-org', 'user', '2026-08-03 23:59:00', 'chat')",
    [newRun],
  );
  await rejects(
    "UPDATE billing_run_attribution SET source='other' WHERE run_id=$1",
    [newRun],
  );
  await rejects(
    "UPDATE usage_event SET billing_anchor_at='2026-08-04' WHERE id=$1",
    [late],
  );
  await rejects(
    "INSERT INTO usage_event (run_id, org_id, user_id) VALUES ($1, 'other-org', 'user')",
    [newRun],
  );

  const job = randomUUID();
  await client.query(
    "INSERT INTO built_in_generation_jobs (id, run_id, org_id, user_id) VALUES ($1, $2, 'org', 'user')",
    [job, newRun],
  );
  await client.query("DELETE FROM agent_runs WHERE id=$1", [newRun]);
  assert.deepEqual(
    (
      await client.query(
        "SELECT run_id, billing_run_id, billing_context FROM usage_event WHERE id=$1",
        [late],
      )
    ).rows,
    [{ run_id: null, billing_run_id: newRun, billing_context: "run" }],
  );
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::int AS n FROM billing_run_attribution WHERE run_id=$1",
        [newRun],
      )
    ).rows[0].n,
    1,
  );
  await client.query(
    "INSERT INTO usage_event (run_id, billing_run_id, billing_context, org_id, user_id) SELECT run_id, billing_run_id, billing_context, org_id, user_id FROM built_in_generation_jobs WHERE id=$1",
    [job],
  );
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::int AS n FROM usage_event WHERE billing_run_id=$1",
        [newRun],
      )
    ).rows[0].n,
    2,
  );

  await client.query(
    "INSERT INTO usage_event (org_id, user_id, created_at, billing_context) VALUES ('org','user','2026-08-05 12:34:56','runless')",
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT billing_context, billing_anchor_at::text FROM usage_event WHERE billing_context='runless'",
      )
    ).rows,
    [{ billing_context: "runless", billing_anchor_at: "2026-08-05 12:34:56" }],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT billing_context, billing_anchor_at FROM usage_event WHERE id=$1",
        [missing],
      )
    ).rows,
    [{ billing_context: "legacy_unknown", billing_anchor_at: null }],
  );

  const provisional = randomUUID();
  await client.query(
    "INSERT INTO agent_runs VALUES ($1, 'org', 'user', '2026-08-06', 'web', 'private')",
    [provisional],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT purge_quiescent_provisional_billing_attribution('org','user',ARRAY[$1]::uuid[]) AS n",
        [provisional],
      )
    ).rows,
    [{ n: 0 }],
  );
  await client.query("DELETE FROM agent_runs WHERE id=$1", [provisional]);
  assert.deepEqual(
    (
      await client.query(
        "SELECT purge_quiescent_provisional_billing_attribution('other-org','user',ARRAY[$1]::uuid[]) AS n",
        [provisional],
      )
    ).rows,
    [{ n: 0 }],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT purge_quiescent_provisional_billing_attribution('org','user',ARRAY[$1]::uuid[]) AS n",
        [provisional],
      )
    ).rows,
    [{ n: 1 }],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT purge_quiescent_provisional_billing_attribution('org','user',ARRAY[$1]::uuid[]) AS n",
        [provisional],
      )
    ).rows,
    [{ n: 0 }],
  );
  await rejects(
    "UPDATE billing_run_attribution SET usage_observed=false WHERE run_id=$1",
    [newRun],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT purge_quiescent_provisional_billing_attribution('org','user',ARRAY[$1]::uuid[]) AS n",
        [newRun],
      )
    ).rows,
    [{ n: 0 }],
  );

  const before = await cli([
    "--max-rows",
    "100",
    "--writer-since",
    "2026-08-01T00:00:00Z",
  ]);
  assert.equal(before.mode, "dry-run");
  assert.equal(before.truncated, false);
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::int AS n FROM billing_attribution_backfill",
      )
    ).rows[0].n,
    0,
  );
  assert.equal((await cli(["--max-rows", "1"])).truncated, true);
  const jobId = randomUUID();
  const flags = [
    "--migrate",
    "--ack-writer-drain",
    "--job-id",
    jobId,
    "--max-rows",
    "1",
    "--batch-size",
    "1",
    "--max-ms",
    "10000",
  ];
  await cli(flags);
  const first = (
    await client.query(
      "SELECT scanned::text FROM billing_attribution_backfill WHERE id=$1",
      [jobId],
    )
  ).rows;
  assert.deepEqual(first, [{ scanned: "1" }]);
  await client.query(`CREATE FUNCTION interrupt_billing_batch() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected billing batch interruption' USING ERRCODE='57014'; END $$;
    CREATE TRIGGER interrupt_billing_batch AFTER UPDATE ON usage_event FOR EACH ROW EXECUTE FUNCTION interrupt_billing_batch();`);
  await assert.rejects(
    cli([
      "--migrate",
      "--ack-writer-drain",
      "--job-id",
      jobId,
      "--max-rows",
      "100",
      "--batch-size",
      "1",
      "--max-ms",
      "10000",
    ]),
    /injected billing batch interruption/,
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT billing_anchor_at, billing_context FROM usage_event WHERE id=$1",
        [pending],
      )
    ).rows,
    [{ billing_anchor_at: null, billing_context: "legacy_unknown" }],
  );
  const interrupted = (
    await client.query(
      "SELECT phase FROM billing_attribution_backfill WHERE id=$1",
      [jobId],
    )
  ).rows;
  assert.deepEqual(interrupted, [{ phase: "raw" }]);
  await client.query(
    "DROP TRIGGER interrupt_billing_batch ON usage_event; DROP FUNCTION interrupt_billing_batch()",
  );
  // Each invocation stops on a fixed row budget. Restart reads committed progress;
  // no timestamp or amount is replaced, including int8 values above 2^53.
  await cli([
    "--migrate",
    "--ack-writer-drain",
    "--job-id",
    jobId,
    "--max-rows",
    "100",
    "--batch-size",
    "1",
    "--max-ms",
    "10000",
  ]);
  assert.equal(
    (
      await client.query(
        "SELECT phase FROM billing_attribution_backfill WHERE id=$1",
        [jobId],
      )
    ).rows[0].phase,
    "done",
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT billing_anchor_at::text, quantity::text FROM usage_event WHERE id=$1",
        [pending],
      )
    ).rows,
    [{ billing_anchor_at: "2026-08-01 23:59:00", quantity: "9" }],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT billing_run_id, billing_anchor_at::text, quantity::text, credits_charged::text, allowance_units::text FROM usage_event_hourly_rollup",
      )
    ).rows,
    [
      {
        billing_run_id: rollupRun,
        billing_anchor_at: "2026-08-01 20:00:00",
        quantity: "9007199254740993",
        credits_charged: "100",
        allowance_units: "23",
      },
    ],
  );
  const checkpoint = (
    await client.query(
      "SELECT scanned::text, populated::text FROM billing_attribution_backfill WHERE id=$1",
      [jobId],
    )
  ).rows;
  await cli(flags);
  assert.deepEqual(
    (
      await client.query(
        "SELECT scanned::text, populated::text FROM billing_attribution_backfill WHERE id=$1",
        [jobId],
      )
    ).rows,
    checkpoint,
  );
  await assert.rejects(
    cli([...flags, "--user-id", "different"]),
    /checkpoint scope cannot change/,
  );
  const after = await cli([
    "--max-rows",
    "100",
    "--writer-since",
    "2026-08-01T00:00:00Z",
  ]);
  assert.equal(after.activationReady, false);
  assert.deepEqual(after.counts, {
    scanned: 9,
    eligible: 0,
    populated: 8,
    missing_source: 1,
    conflicts: 0,
    pending_anchor_gaps: 1,
    new_writer_gaps: 1,
    pending_generation_gaps: 0,
  });
  await client.query(
    "INSERT INTO agent_runs VALUES ($1, 'other-org', 'other-user', '2026-08-07', 'web', 'private')",
    [provisional],
  );
  // A pre-existing bad owner association can only be constructed below the
  // runtime write guard. This isolated schema is the migration fixture.
  await client.query(
    "ALTER TABLE usage_event DISABLE TRIGGER capture_usage_billing_attribution",
  );
  await client.query(
    "INSERT INTO usage_event (run_id, org_id, user_id, quantity) VALUES ($1, 'org', 'user', 17)",
    [provisional],
  );
  await client.query(
    "ALTER TABLE usage_event ENABLE TRIGGER capture_usage_billing_attribution",
  );
  const conflictJob = randomUUID();
  await cli([
    "--migrate",
    "--ack-writer-drain",
    "--job-id",
    conflictJob,
    "--max-rows",
    "100",
    "--max-ms",
    "10000",
  ]);
  assert.equal(
    (
      await client.query(
        "SELECT conflicts::int AS n FROM billing_attribution_backfill WHERE id=$1",
        [conflictJob],
      )
    ).rows[0].n,
    1,
  );
  const conflictingReport = await cli(["--max-rows", "100"]);
  assert.ok(
    conflictingReport.counts !== null &&
      typeof conflictingReport.counts === "object",
  );
  assert.equal(
    Object.fromEntries(Object.entries(conflictingReport.counts)).conflicts,
    1,
  );
  assert.deepEqual(conflictingReport.conflictingRunIds, [provisional]);
  assert.deepEqual(
    (
      await client.query(
        "SELECT quantity::text, billing_context, billing_anchor_at FROM usage_event WHERE run_id=$1",
        [provisional],
      )
    ).rows,
    [
      {
        quantity: "17",
        billing_context: "legacy_unknown",
        billing_anchor_at: null,
      },
    ],
  );
  console.log(
    "Billing attribution: atomic capture, immutable conflicts, deletion isolation, runless provenance, bounded restart and exact monetary preservation passed",
  );
} finally {
  await client.query(`DROP SCHEMA "${schema}" CASCADE`);
  await client.end();
}
