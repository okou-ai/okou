import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

/** Real current tables plus pre-D capture, never a production database operation. */
export async function validatePiMemoryStage1Cost(
  databaseUrl: string,
): Promise<void> {
  const schema = `stage1_cost_${randomUUID().replaceAll("-", "")}`;
  const client = new Client({ connectionString: databaseUrl });
  const writer = new Client({ connectionString: databaseUrl });
  await client.connect();
  await writer.connect();
  const migration = async (name: string) => {
    return await readFile(
      new URL(`../src/migrations/${name}.sql`, import.meta.url),
      "utf8",
    );
  };
  const query = await readFile(
    new URL("../../../../ops/pi-memory-stage1/v1/ledger.sql", import.meta.url),
    "utf8",
  );
  const org = randomUUID();
  const model = `scale-${randomUUID()}`;
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
    // Replay exactly the pre-D CHECK/capture bodies against actual current
    // physical columns. No product endpoint can create this deployment state.
    await client.query(
      "ALTER TABLE usage_event DROP CONSTRAINT usage_event_billing_context_check; ALTER TABLE usage_event_hourly_rollup DROP CONSTRAINT usage_event_hourly_rollup_billing_context_check",
    );
    const oldChecks = await migration("1118_billing_run_attribution");
    await client.query(
      oldChecks.slice(
        oldChecks.indexOf(
          'ALTER TABLE "usage_event_hourly_rollup" ADD CONSTRAINT',
        ),
      ),
    );
    const oldCapture = await migration("1119_billing_attribution_capture");
    await client.query(
      oldCapture.slice(
        oldCapture.indexOf(
          "CREATE FUNCTION capture_usage_billing_attribution()",
        ),
        oldCapture.indexOf(
          "--> statement-breakpoint\nCREATE TRIGGER capture_usage_billing_attribution",
        ),
      ),
    );
    for (const table of ["usage_event", "usage_event_hourly_rollup"]) {
      await client.query(
        `CREATE TRIGGER capture_usage_billing_attribution BEFORE INSERT OR UPDATE OF billing_run_id,billing_anchor_at,billing_context,org_id,user_id ON "${table}" FOR EACH ROW EXECUTE FUNCTION capture_usage_billing_attribution()`,
      );
    }
    for (let start = 0; start < 134426; start += 5000) {
      await client.query(
        `INSERT INTO usage_event(idempotency_key,org_id,user_id,kind,provider,category,quantity,credits_charged,status,created_at,processed_at,billing_context)
        SELECT gen_random_uuid(), $1,'user','model',$2,'tokens.input',3,0,'processed',timestamp '2026-09-01'+(i%30)*interval '1 day',timestamp '2026-09-01','runless' FROM generate_series($3::int,$4::int) i`,
        [org, model, start, Math.min(start + 4999, 134425)],
      );
    }
    for (let start = 0; start < 321528; start += 5000) {
      await client.query(
        `INSERT INTO usage_event_hourly_rollup(processed_hour,org_id,user_id,kind,provider,category,quantity,credits_charged,allowance_units,billing_context,billing_anchor_at)
        SELECT timestamp '2026-09-01',$1,'user','model',$2,'tokens.input',3,0,0,'runless',timestamp '2026-09-01'+(i%30)*interval '1 day' FROM generate_series($3::int,$4::int) i`,
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
    const apply = async (name: string) => {
      const started = performance.now();
      for (const statement of (await migration(name)).split(
        "--> statement-breakpoint",
      )) {
        if (statement.trim()) await client.query(statement);
      }
      return Math.round(performance.now() - started);
    };
    await client.query(
      "BEGIN; SET LOCAL lock_timeout='1s'; SET LOCAL statement_timeout='10s'",
    );
    const expandMs = await apply("1137_pi_memory_stage1_billing_context");
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid IN ('usage_event'::regclass,'usage_event_hourly_rollup'::regclass) AND conname LIKE '%billing_context_check' AND NOT convalidated",
        )
      ).rows[0].n,
      2,
    );
    await client.query("COMMIT");
    await client.query(
      "BEGIN; SET LOCAL lock_timeout='1s'; SET LOCAL statement_timeout='10s'",
    );
    const validateMs = await apply(
      "1138_validate_pi_memory_stage1_billing_context",
    );
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM pg_locks WHERE pid=pg_backend_pid() AND relation IN ('usage_event'::regclass,'usage_event_hourly_rollup'::regclass) AND mode='AccessExclusiveLock'",
        )
      ).rows[0].n,
      0,
    );
    // Validation's lock remains held here; old and new writers still commit.
    await writer.query(
      "INSERT INTO usage_event(idempotency_key,org_id,user_id,kind,provider,category,quantity,billing_context,created_at) VALUES(gen_random_uuid(),$1,'user','model',$2,'tokens.input',9007199254740993,'pi_memory_stage1','2026-09-15'),(gen_random_uuid(),$1,'user','model',$2,'tokens.output',2,'runless','2026-09-15')",
      [org, model],
    );
    await client.query("COMMIT");
    const auditOrg = randomUUID();
    await writer.query(
      "INSERT INTO usage_event(idempotency_key,org_id,user_id,kind,provider,category,quantity,billing_context,created_at) VALUES(gen_random_uuid(),$1,'user','model',$2,'tokens.input',1,'pi_memory_stage1','2026-09-15')",
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
    await client.query(
      "INSERT INTO usage_pricing(kind,provider,category,unit_price,unit_size) VALUES('model',$1,'tokens.input',3,1000000)",
      [model],
    );
    await client.query(
      "INSERT INTO usage_event(idempotency_key,org_id,user_id,kind,provider,category,quantity,billing_context,created_at,billing_error) VALUES(gen_random_uuid(),$1,'user','model',$2,'tokens.output',2,'pi_memory_stage1','2026-09-15','missing_pricing')",
      [org, model],
    );
    await client.query(
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='5s'",
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
    await client.query("COMMIT");
    console.log(
      JSON.stringify({
        test: "stage1-cost-scale",
        census,
        expandMs,
        validateMs,
        planningMs: plan["Planning Time"],
        executionMs: plan["Execution Time"],
        sharedHitBlocks: plan.Plan["Shared Hit Blocks"],
        sharedReadBlocks: plan.Plan["Shared Read Blocks"],
        plan: plan.Plan,
      }),
    );
  } finally {
    await client.query("ROLLBACK");
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
