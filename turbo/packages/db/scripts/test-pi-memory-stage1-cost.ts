import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

/** Current-schema cost and CLI contracts, never a production database operation. */
export async function validatePiMemoryStage1Cost(
  databaseUrl: string,
): Promise<void> {
  const schema = `stage1_cost_${randomUUID().replaceAll("-", "")}`;
  const client = new Client({ connectionString: databaseUrl });
  const writer = new Client({ connectionString: databaseUrl });
  await client.connect();
  await writer.connect();
  const query = await readFile(
    new URL("../../../../ops/pi-memory-stage1/v1/ledger.sql", import.meta.url),
    "utf8",
  );
  const org = randomUUID();
  const model = `scale-${randomUUID()}`;
  let readPhaseSettings:
    { readOnly: string; statementTimeout: string } | undefined;
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    for (const connection of [client, writer]) {
      await connection.query(
        `SET search_path TO "${schema}", public; SET TIME ZONE 'UTC'; SET lock_timeout='1s'; SET statement_timeout='10s'`,
      );
    }
    for (const table of [
      "usage_event",
      "usage_event_hourly_rollup",
      "usage_pricing",
      "agent_runs",
      "billing_run_attribution",
      "built_in_generation_jobs",
      "billing_attribution_backfill",
    ]) {
      await client.query(
        `CREATE TABLE "${table}" (LIKE public."${table}" INCLUDING ALL)`,
      );
    }
    for (let start = 0; start < 134426; start += 5000) {
      await client.query(
        `INSERT INTO usage_event(idempotency_key,org_id,user_id,kind,provider,category,quantity,credits_charged,status,created_at,processed_at,billing_context,billing_anchor_at)
        SELECT gen_random_uuid(), $1,'user','model',$2,'tokens.input',3,0,'processed',timestamp '2026-09-01'+(i%30)*interval '1 day',timestamp '2026-09-01','runless',timestamp '2026-09-01'+(i%30)*interval '1 day' FROM generate_series($3::int,$4::int) i`,
        [org, model, start, Math.min(start + 4999, 134425)],
      );
    }
    for (let start = 0; start < 321528; start += 5000) {
      await client.query(
        `INSERT INTO usage_event_hourly_rollup(processed_hour,org_id,user_id,kind,provider,category,quantity,credits_charged,billing_context,billing_anchor_at)
        SELECT timestamp '2026-09-01',$1,'user','model',$2,'tokens.input',3,0,'runless',timestamp '2026-09-01'+(i%30)*interval '1 day' FROM generate_series($3::int,$4::int) i`,
        [org, model, start, Math.min(start + 4999, 321527)],
      );
    }
    await client.query(
      "ANALYZE usage_event; ANALYZE usage_event_hourly_rollup",
    );
    const census = (
      await client.query(
        "SELECT (SELECT count(*)::text FROM usage_event) AS raw, (SELECT count(*)::text FROM usage_event_hourly_rollup) AS hourly",
      )
    ).rows[0];
    assert.deepEqual(census, { raw: "134426", hourly: "321528" });
    await writer.query(
      "INSERT INTO usage_event(idempotency_key,org_id,user_id,kind,provider,category,quantity,billing_context,created_at,billing_anchor_at) VALUES(gen_random_uuid(),$1,'user','model',$2,'tokens.input',9007199254740993,'pi_memory_stage1','2026-09-15','2026-09-15'),(gen_random_uuid(),$1,'user','model',$2,'tokens.output',2,'runless','2026-09-15','2026-09-15')",
      [org, model],
    );
    const auditOrg = randomUUID();
    await writer.query(
      "INSERT INTO usage_event(idempotency_key,org_id,user_id,kind,provider,category,quantity,billing_context,created_at,billing_anchor_at) VALUES(gen_random_uuid(),$1,'user','model',$2,'tokens.input',1,'pi_memory_stage1','2026-09-15','2026-09-15')",
      [auditOrg, model],
    );
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-c search_path=${schema},public`);
    const audit = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/billing-attribution.ts",
        "--org-id",
        auditOrg,
        "--max-rows",
        "10",
        "--max-ms",
        "5000",
      ],
      { env: { ...process.env, DATABASE_URL: scopedUrl.toString() } },
    );
    const inventory = JSON.parse(audit.stdout);
    assert.equal(inventory.counts.populated, 1);
    assert.equal(inventory.counts.eligible, 0);
    assert.equal(inventory.counts.pending_anchor_gaps, 0);
    assert.equal(inventory.counts.missing_source, 0);
    assert.deepEqual(inventory, {
      mode: "dry-run",
      scope: [auditOrg, null, null, null],
      counts: {
        scanned: 1,
        eligible: 0,
        populated: 1,
        missing_source: 0,
        conflicts: 0,
        pending_anchor_gaps: 0,
        new_writer_gaps: 0,
        pending_generation_gaps: 0,
        thread_gaps: 0,
      },
      conflictingRunIds: [],
      truncated: false,
      writerCoverageSince: null,
      activationReady: false,
      note: "A1 inventory only. A2 also requires closure/fencing, verified writer drain, no conflicts or pending anchor gaps, and a complete scoped inventory.",
    });
    console.log("Billing attribution dry-run CLI inventory contract passed");
    // Exercise the maintained operator through its real CLI, in this schema.
    const migrateOrg = randomUUID();
    const migrateRun = randomUUID();
    const migrateJob = randomUUID();
    await writer.query(
      `INSERT INTO agent_runs(id,org_id,user_id,status,prompt,trigger_source,autonomy_budget,created_at)
      VALUES($1,$2,'user','completed','attribution fixture','web',0,'2026-09-15')`,
      [migrateRun, migrateOrg],
    );
    await writer.query(
      `INSERT INTO built_in_generation_jobs(type,status,org_id,user_id,run_id,request)
      VALUES('image','completed',$1,'user',$2,'{}')`,
      [migrateOrg, migrateRun],
    );
    await writer.query(
      `INSERT INTO usage_event(idempotency_key,org_id,user_id,run_id,kind,provider,category,quantity)
      VALUES(gen_random_uuid(),$1,'user',$2,'model',$3,'tokens.input',1)`,
      [migrateOrg, migrateRun, model],
    );
    await writer.query(
      `INSERT INTO usage_event_hourly_rollup(processed_hour,org_id,user_id,run_id,kind,provider,category,quantity,credits_charged)
      VALUES('2026-09-15',$1,'user',$2,'model',$3,'tokens.input',1,0)`,
      [migrateOrg, migrateRun, model],
    );
    const migrate = async (maxRows: string) => {
      const result = await promisify(execFile)(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/billing-attribution.ts",
          "--org-id",
          migrateOrg,
          "--migrate",
          "--ack-writer-drain",
          "--job-id",
          migrateJob,
          "--batch-size",
          "1",
          "--max-rows",
          maxRows,
          "--max-ms",
          "5000",
        ],
        { env: { ...process.env, DATABASE_URL: scopedUrl.toString() } },
      );
      return JSON.parse(result.stdout);
    };
    const firstBatch = await migrate("1");
    assert.equal(firstBatch.scannedThisInvocation, 1);
    assert.equal(firstBatch.checkpoint.phase, "runs");
    assert.equal(firstBatch.checkpoint.scanned, "1");
    assert.equal(firstBatch.checkpoint.populated, "1");
    // A real statement failure must preserve the last committed batch and leave
    // the rejected batch's source writes unapplied. No trigger or lock fixture.
    await writer.query(
      "ALTER TABLE billing_attribution_backfill ADD CONSTRAINT fixture_batch_failure CHECK (populated < 2)",
    );
    await assert.rejects(migrate("20"), /fixture_batch_failure/);
    const failedBatch = (
      await writer.query(
        "SELECT phase,scanned,populated FROM billing_attribution_backfill WHERE id=$1",
        [migrateJob],
      )
    ).rows[0];
    assert.deepEqual(failedBatch, {
      phase: "jobs",
      scanned: "1",
      populated: "1",
    });
    const rejectedSource = (
      await writer.query(
        "SELECT billing_context FROM built_in_generation_jobs WHERE org_id=$1",
        [migrateOrg],
      )
    ).rows[0];
    assert.equal(rejectedSource.billing_context, "legacy_unknown");
    await writer.query(
      "ALTER TABLE billing_attribution_backfill DROP CONSTRAINT fixture_batch_failure",
    );
    const resumed = await migrate("20");
    assert.equal(resumed.scannedThisInvocation, 3);
    assert.equal(resumed.checkpoint.phase, "done");
    assert.equal(resumed.checkpoint.scanned, "4");
    assert.equal(resumed.checkpoint.populated, "4");
    assert.equal(resumed.checkpoint.missing_source, "0");
    assert.equal(resumed.checkpoint.conflicts, "0");
    assert.equal(resumed.activationReady, false);
    const observed = (
      await writer.query(
        "SELECT usage_observed FROM billing_run_attribution WHERE run_id=$1",
        [migrateRun],
      )
    ).rows[0];
    assert.equal(observed.usage_observed, true);
    const completed = await migrate("20");
    assert.equal(completed.scannedThisInvocation, 0);
    assert.deepEqual(completed.checkpoint, resumed.checkpoint);
    console.log(
      "Billing attribution migrate CLI atomic batch and resume contract passed",
    );
    await client.query(
      "INSERT INTO usage_pricing(kind,provider,category,unit_price,unit_size) VALUES('model',$1,'tokens.input',3,1000000)",
      [model],
    );
    await client.query(
      "INSERT INTO usage_event(idempotency_key,org_id,user_id,kind,provider,category,quantity,billing_context,created_at,billing_error,billing_anchor_at) VALUES(gen_random_uuid(),$1,'user','model',$2,'tokens.output',2,'pi_memory_stage1','2026-09-15','missing_pricing','2026-09-15')",
      [org, model],
    );
    const settings: Record<string, unknown> = (
      await client.query(
        "SELECT current_setting('default_transaction_read_only') AS read_only, current_setting('statement_timeout') AS statement_timeout",
      )
    ).rows[0];
    assert.ok(typeof settings.read_only === "string");
    assert.ok(typeof settings.statement_timeout === "string");
    readPhaseSettings = {
      readOnly: settings.read_only,
      statementTimeout: settings.statement_timeout,
    };
    await client.query(
      "SELECT set_config('default_transaction_read_only','on',false), set_config('statement_timeout','5s',false)",
    );
    const report = (await client.query(query, ["2026-09-15", org, "user", {}]))
      .rows[0].report;
    assert.equal(report.stage1_pending_rows, "2");
    assert.equal(report.stage1_unknown_price_rows, "1");
    assert.equal(report.stage1_billing_error_rows, "1");
    assert.match(report.known_stage1_gross_usd, /^27021597\.7642229790*$/);
    const plan = (
      await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`, [
        "2026-09-15",
        null,
        null,
        {},
      ])
    ).rows[0]["QUERY PLAN"][0];
    const cli = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/pi-memory-stage1-cost.ts",
        "--day",
        "2026-09-15",
        "--org-id",
        org,
        "--user-id",
        "user",
      ],
      { env: { ...process.env, DATABASE_URL: scopedUrl.toString() } },
    );
    const cliReport: unknown = JSON.parse(cli.stdout);
    assert.ok(
      cliReport !== null &&
        typeof cliReport === "object" &&
        "snapshot_at" in cliReport,
    );
    assert.ok(typeof cliReport.snapshot_at === "string");
    assert.match(
      cliReport.snapshot_at,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/,
    );
    assert.ok(Number.isFinite(Date.parse(cliReport.snapshot_at)));
    // The CLI samples its own report transaction, not the earlier fixture clock.
    assert.deepEqual({ ...cliReport, snapshot_at: report.snapshot_at }, report);
    console.log("Pi Memory Stage1 cost CLI report contract passed");
    console.log(
      JSON.stringify({
        test: "stage1-cost-scale",
        census,
        planningMs: plan["Planning Time"],
        executionMs: plan["Execution Time"],
        sharedHitBlocks: plan.Plan["Shared Hit Blocks"],
        sharedReadBlocks: plan.Plan["Shared Read Blocks"],
        plan: plan.Plan,
      }),
    );
  } finally {
    if (readPhaseSettings) {
      await client.query(
        "SELECT set_config('default_transaction_read_only',$1,false), set_config('statement_timeout',$2,false)",
        [readPhaseSettings.readOnly, readPhaseSettings.statementTimeout],
      );
    }
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await Promise.all([client.end(), writer.end()]);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert.ok(
    process.env.DATABASE_URL,
    "DATABASE_URL is required (local test schema only)",
  );
  await validatePiMemoryStage1Cost(process.env.DATABASE_URL);
}
