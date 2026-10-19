import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import postgres from "postgres";
import { z } from "zod";
import { applyPendingMigrations } from "./migration-runner";

// The migration runner is the production caller for historical SQL shapes.
// Retain until the backfill ships and the receipt reader cutover is accepted (#37796).
const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
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
const target = journal.entries.find((entry) => {
  return entry.tag.endsWith("_backfill_billing_run_lifecycle");
});
assert.ok(target, "Billing lifecycle backfill must exist");
const databaseName = `billing_lifecycle_backfill_${randomUUID().replaceAll("-", "")}`;
const admin = new Client({ connectionString: databaseUrl });
await admin.connect();
const ownedUrl = new URL(databaseUrl);
ownedUrl.pathname = `/${databaseName}`;
await admin.query(`CREATE DATABASE "${databaseName}"`);
const migrationClient = postgres(ownedUrl.toString(), {
  max: 1,
  onnotice: () => {},
});
const client = new Client({ connectionString: ownedUrl.toString() });
const anchor = "2026-08-01 00:00:00.123456";
const completed = "2026-08-01 00:01:00.654321";
const terminalStatuses = ["completed", "failed", "cancelled", "timeout"];
const ledgerTables = ["usage_event", "usage_event_hourly_rollup"] as const;

function uuid(id: number): string {
  return `00000000-0000-4000-8000-${id.toString().padStart(12, "0")}`;
}

async function createRun(
  id: number,
  status = "completed",
  at: string | null = completed,
  source: string | null = "web",
) {
  await client.query(
    `INSERT INTO agent_runs
      (id, org_id, user_id, status, prompt, trigger_source, autonomy_budget, created_at, completed_at)
    VALUES ($1, 'lifecycle-org', 'lifecycle-user', $2, 'Historical input', $3::varchar,
      CASE WHEN $3::varchar IS NULL THEN NULL ELSE 32 END, $4, $5)`,
    [uuid(id), status, source, anchor, at],
  );
}

async function createAttribution(
  id: number,
  context = "unknown",
  status: string | null = null,
  at: string | null = null,
  source = "chat",
) {
  await client.query(
    `INSERT INTO billing_run_attribution
      (run_id, org_id, user_id, run_started_at, source, thread_id, thread_context,
       usage_observed, captured_at, run_lifecycle_context, run_terminal_status, run_completed_at)
    VALUES ($1, 'lifecycle-org', 'lifecycle-user', $2, $3, $4, 'thread', true,
      '2026-08-02 00:00:00.123456', $5, $6, $7)`,
    [uuid(id), anchor, source, uuid(9000), context, status, at],
  );
}

async function facts(query: string): Promise<string[]> {
  const result = await client.query(query);
  return z
    .array(z.object({ fact: z.string() }))
    .parse(result.rows)
    .map((row) => {
      return row.fact;
    });
}

async function lifecycle(id: number) {
  const result = await client.query(
    `SELECT run_lifecycle_context AS context, run_terminal_status AS status,
      run_completed_at::text AS completed_at
    FROM billing_run_attribution WHERE run_id = $1`,
    [uuid(id)],
  );
  return z
    .tuple([
      z.object({
        context: z.string(),
        status: z.string().nullable(),
        completed_at: z.string().nullable(),
      }),
    ])
    .parse(result.rows)[0];
}

try {
  await applyPendingMigrations(migrationClient, { beforeMillis: target.when });
  await client.connect();
  // Two complete no-op batches must advance to later eligible records.
  await client.query(
    `INSERT INTO billing_run_attribution
      (run_id, org_id, user_id, run_started_at, source, run_lifecycle_context, run_terminal_status, run_completed_at)
    SELECT ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
      'lifecycle-org', 'lifecycle-user', $1::timestamp, 'chat', 'captured', 'completed', $2::timestamp
    FROM generate_series(1, 1000) i`,
    [anchor, completed],
  );
  // A complete eligible batch commits before a later conflicted batch fails.
  await client.query(
    `INSERT INTO agent_runs (id, org_id, user_id, status, prompt, created_at, completed_at)
    SELECT ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
      'lifecycle-org', 'lifecycle-user', 'completed', 'Historical input', $1::timestamp, $2::timestamp
    FROM generate_series(1001, 1500) i`,
    [anchor, completed],
  );
  await client.query(`INSERT INTO billing_run_attribution
      (run_id, org_id, user_id, run_started_at, source)
    SELECT id, org_id, user_id, created_at, 'other' FROM agent_runs`);
  const conflictChanges = [
    "org_id = 'outside-org'",
    "user_id = 'outside-user'",
    "run_started_at = run_started_at + interval '1 microsecond'",
    "source = 'automation'",
    "run_lifecycle_context = 'captured', run_terminal_status = 'failed'",
    `run_lifecycle_context = 'captured', run_terminal_status = 'completed', run_completed_at = '${completed}'::timestamp + interval '1 microsecond'`,
    "run_lifecycle_context = 'legacy_unavailable'",
  ];
  for (const [index, change] of conflictChanges.entries()) {
    const id = 2001 + index;
    await createRun(id);
    await createAttribution(id);
    await client.query(
      `UPDATE billing_run_attribution SET ${change} WHERE run_id = $1`,
      [uuid(id)],
    );
  }
  await createRun(2008, "unexpected", null);
  await createAttribution(2008);
  await createRun(2009, "running", completed);
  await createAttribution(2009);
  await createRun(2010, "running", null);
  await createAttribution(2010, "captured", "completed", completed);
  await createRun(2011);
  await createAttribution(2011);
  const conflictBefore = await facts(
    `SELECT to_jsonb(a)::text AS fact FROM billing_run_attribution a WHERE run_id >= '${uuid(2001)}' ORDER BY run_id`,
  );
  await assert.rejects(
    applyPendingMigrations(migrationClient, { beforeMillis: target.when + 1 }),
    (error: unknown) => {
      return (
        error instanceof Error &&
        "code" in error &&
        error.code === "22P02" &&
        error.message.includes("billing run lifecycle backfill conflict: 10")
      );
    },
  );
  assert.deepEqual(await lifecycle(1001), {
    context: "captured",
    status: "completed",
    completed_at: completed,
  });
  assert.deepEqual(
    await facts(
      `SELECT to_jsonb(a)::text AS fact FROM billing_run_attribution a WHERE run_id >= '${uuid(2001)}' ORDER BY run_id`,
    ),
    conflictBefore,
    "A rejected batch must leave every conflicting and eligible row untouched",
  );
  assert.equal(
    (
      await client.query(
        "SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = $1",
        [target.when],
      )
    ).rowCount,
    0,
    "A conflicted backfill must not advance its migration journal",
  );
  // Reconcile only disposable conflicting fixtures, then retry the actual runner.
  await client.query("DELETE FROM billing_run_attribution WHERE run_id >= $1", [
    uuid(2001),
  ]);
  await client.query("DELETE FROM agent_runs WHERE id >= $1", [uuid(2001)]);

  for (const [index, status] of terminalStatuses.entries()) {
    await createRun(3000 + index, status);
    await createAttribution(3000 + index);
  }
  for (const [index, status] of ["pending", "running"].entries()) {
    await createRun(3010 + index, status, null);
    await createAttribution(3010 + index);
  }
  await createAttribution(3020);
  await createAttribution(3021, "captured");
  await createAttribution(3022, "captured", "failed", completed);
  await createAttribution(3023, "legacy_unavailable");
  await createRun(3024, "failed", null);
  await createAttribution(3024);
  await createRun(3025);
  await createAttribution(3025, "captured", "completed");
  await createRun(3026);
  await createAttribution(3026, "captured");
  await createRun(3027, "completed", null);
  await createAttribution(3027, "captured", "completed", completed);
  await createRun(3028); // No obligation identity exists: never manufacture one.
  const sources = [
    "web",
    "automation-schedule",
    "automation-event",
    "slack",
    "discord",
    "wechat",
    "teams",
    "telegram",
    "email",
    "agentphone",
    "github",
    "agent",
    "future-source",
    null,
  ];
  for (const [index, source] of sources.entries()) {
    await createRun(3100 + index, "completed", completed, source);
    await createAttribution(
      3100 + index,
      "unknown",
      null,
      null,
      source === "web"
        ? "chat"
        : source?.startsWith("automation-")
          ? "automation"
          : source === null || source === "future-source"
            ? "other"
            : source,
    );
  }
  for (const table of ledgerTables) {
    const raw = table === "usage_event";
    await client.query(`INSERT INTO ${table}
      (id, org_id, user_id, run_id, billing_run_id, billing_anchor_at, billing_context,
       kind, provider, category, quantity, credits_charged,
       ${raw ? "idempotency_key, pricing_unit_price, pricing_unit_size, pricing_credits_limit, status, created_at, processed_at" : "processed_hour"})
      VALUES (gen_random_uuid(), 'lifecycle-org', 'lifecycle-user', '${uuid(3000)}', '${uuid(3000)}', '${anchor}', 'run',
        'model', 'historical-provider', 'tokens.input', 2323, 7,
        ${raw ? "gen_random_uuid(), 17, 1000, 20000, 'processed', '2026-08-01 22:00:00', '2026-08-02 00:45:00'" : "'2026-08-02 00:00:00'"})`);
  }
  const immutableQuery = `SELECT (to_jsonb(a) - ARRAY['run_lifecycle_context', 'run_terminal_status', 'run_completed_at'])::text AS fact
    FROM billing_run_attribution a ORDER BY run_id`;
  const immutableBefore = await facts(immutableQuery);
  const runsBefore = await facts(
    "SELECT to_jsonb(r)::text AS fact FROM agent_runs r ORDER BY id",
  );
  const ledgersBefore =
    await facts(`SELECT to_jsonb(u)::text AS fact FROM usage_event u
    UNION ALL SELECT to_jsonb(h)::text FROM usage_event_hourly_rollup h ORDER BY fact`);
  await applyPendingMigrations(migrationClient, {
    beforeMillis: target.when + 1,
  });
  assert.deepEqual(await facts(immutableQuery), immutableBefore);
  assert.deepEqual(
    await facts(
      "SELECT to_jsonb(r)::text AS fact FROM agent_runs r ORDER BY id",
    ),
    runsBefore,
  );
  assert.deepEqual(
    await facts(`SELECT to_jsonb(u)::text AS fact FROM usage_event u
    UNION ALL SELECT to_jsonb(h)::text FROM usage_event_hourly_rollup h ORDER BY fact`),
    ledgersBefore,
  );
  for (const [index, status] of terminalStatuses.entries()) {
    assert.deepEqual(await lifecycle(3000 + index), {
      context: "captured",
      status,
      completed_at: completed,
    });
  }
  for (const id of [3010, 3011]) {
    assert.deepEqual(await lifecycle(id), {
      context: "captured",
      status: null,
      completed_at: null,
    });
  }
  for (const id of [3020, 3021, 3023]) {
    assert.deepEqual(await lifecycle(id), {
      context: "legacy_unavailable",
      status: null,
      completed_at: null,
    });
  }
  assert.deepEqual(await lifecycle(3022), {
    context: "captured",
    status: "failed",
    completed_at: completed,
  });
  assert.deepEqual(await lifecycle(3024), {
    context: "captured",
    status: "failed",
    completed_at: null,
  });
  for (const id of [
    3025,
    3026,
    3027,
    ...sources.map((_, index) => {
      return 3100 + index;
    }),
  ]) {
    assert.deepEqual(await lifecycle(id), {
      context: "captured",
      status: "completed",
      completed_at: completed,
    });
  }
  assert.equal(
    (
      await client.query(
        "SELECT 1 FROM billing_run_attribution WHERE run_id = $1",
        [uuid(3028)],
      )
    ).rowCount,
    0,
  );
  const allFacts =
    "SELECT to_jsonb(a)::text AS fact FROM billing_run_attribution a ORDER BY run_id";
  const firstPass = await facts(allFacts);
  // A lost journal acknowledgement must not cause a second logical update.
  await client.query(
    "DELETE FROM drizzle.__drizzle_migrations WHERE created_at = $1",
    [target.when],
  );
  await applyPendingMigrations(migrationClient, {
    beforeMillis: target.when + 1,
  });
  assert.deepEqual(await facts(allFacts), firstPass);
  await client.query("DELETE FROM agent_runs WHERE id = $1", [uuid(3000)]);
  assert.deepEqual(await lifecycle(3000), {
    context: "captured",
    status: "completed",
    completed_at: completed,
  });
  console.log(
    "Billing lifecycle backfill: batches, conflict rejection, partial retry, exact clocks, immutable ledgers and replay passed",
  );
} finally {
  await client.end();
  await migrationClient.end();
  await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await admin.end();
}
