import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { z } from "zod";
import { summarizeMigrationPlan } from "./migration-plan";
import { applyPendingMigrations } from "./migration-runner";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const databaseName = `thread_predecessor_${randomUUID().replaceAll("-", "")}`;
const admin = postgres(databaseUrl, { max: 1, onnotice: () => {} });
const url = new URL(databaseUrl);
url.pathname = `/${databaseName}`;
const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
const indexName = "migration_1452_run_thread_owner_executed_idx";
const agentId = "00000000-0000-4000-9000-000000000001";
const hotThreadId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const firstThreadId = "00000000-0000-4000-8000-000000000001";
const hotRunCount = 250_000;

async function seedSkewedHistory(): Promise<void> {
  await sql`INSERT INTO agents (id, org_id, owner, name)
    VALUES (${agentId}, 'dominant-org', 'owner', 'predecessor-skew')`;
  await sql`INSERT INTO chat_threads (id, user_id, agent_id, title)
    SELECT ('00000000-0000-4000-8000-' || lpad(to_hex(i), 12, '0'))::uuid,
      'owner', ${agentId}, 'preserved title'
    FROM generate_series(1, 100) i`;
  await sql`INSERT INTO chat_threads (id, user_id, agent_id)
    VALUES (${hotThreadId}, 'owner', ${agentId})`;
  await sql`INSERT INTO agent_runs
      (id, chat_thread_id, user_id, org_id, agent_id, status, prompt,
       trigger_source, autonomy_budget, created_at, started_at)
    SELECT md5('target-' || t.id || '-' || j)::uuid, t.id,
      CASE WHEN j = 3 THEN 'foreign-owner' ELSE t.user_id END,
      CASE WHEN j = 4 THEN 'foreign-org' ELSE 'dominant-org' END,
      t.agent_id, 'completed', '', 'web', 0,
      timestamp '2026-10-20' + j * interval '1 hour',
      timestamp '2026-10-20' + j * interval '1 hour'
    FROM chat_threads t CROSS JOIN generate_series(1, 4) j
    WHERE t.id <> ${hotThreadId}`;
  await sql`INSERT INTO agent_runs
      (id, chat_thread_id, user_id, org_id, agent_id, status, prompt,
       trigger_source, autonomy_budget, created_at, started_at)
    SELECT md5('hot-' || i)::uuid, ${hotThreadId}, 'owner', 'dominant-org',
      ${agentId}, 'completed', '', 'web', 0, timestamp '2026-10-20',
      timestamp '2026-10-20' + i * interval '1 microsecond'
    FROM generate_series(1, ${hotRunCount}::int) i`;
  await sql`INSERT INTO agents (id, org_id, owner, name)
    SELECT md5('small-agent-' || i)::uuid, 'small-org-' || i,
      'small-owner', 'small-agent-' || i FROM generate_series(1, 1500) i`;
  await sql`INSERT INTO chat_threads (id, user_id, agent_id)
    SELECT ('10000000-0000-4000-8000-' || lpad(to_hex(i), 12, '0'))::uuid,
      'small-owner', md5('small-agent-' || i)::uuid
    FROM generate_series(1, 1500) i`;
  await sql`INSERT INTO agent_runs
      (id, chat_thread_id, user_id, org_id, agent_id, status, prompt,
       trigger_source, autonomy_budget, created_at, started_at)
    SELECT md5('small-run-' || t.id)::uuid, t.id, t.user_id, a.org_id, a.id,
      'completed', '', 'web', 0, timestamp '2026-10-20', timestamp '2026-10-20'
    FROM chat_threads t JOIN agents a ON a.id = t.agent_id
    WHERE t.user_id = 'small-owner'`;
  await sql`ANALYZE agent_runs`;
  await sql`ANALYZE chat_threads`;
  await sql`ANALYZE agents`;
}

async function assertReconciled(): Promise<void> {
  const [result] = await sql`
    SELECT count(*)::int AS incorrect FROM chat_threads t
    WHERE t.agent_id = ${agentId} AND (
      t.framework_session_run_id IS DISTINCT FROM CASE
        WHEN t.id = ${hotThreadId} THEN md5('hot-' || ${hotRunCount}::text)::uuid
        ELSE md5('target-' || t.id || '-2')::uuid END
      OR t.framework IS NOT NULL OR t.framework_session_id IS NOT NULL
      OR (t.id <> ${hotThreadId} AND t.title <> 'preserved title'))`;
  assert.equal(result?.incorrect, 0);
}

async function assertRetryAndPlans(batch: string): Promise<void> {
  // A failed concurrent build can leave a named but invalid index behind.
  await assert.rejects(
    sql.unsafe(
      `CREATE UNIQUE INDEX CONCURRENTLY ${indexName} ON agent_runs (org_id)`,
    ),
    { code: "23505" },
  );
  const [invalid] = await sql`SELECT indisvalid FROM pg_index
    WHERE indexrelid = to_regclass(${indexName})`;
  assert.equal(invalid?.indisvalid, false);
  await sql.unsafe(`ALTER TABLE chat_threads ADD CONSTRAINT test_abort_backfill
    CHECK (id <> '${firstThreadId}' OR framework_session_run_id IS NULL)`);
  await assert.rejects(applyPendingMigrations(sql), { code: "23514" });
  const [index] = await sql`SELECT indisvalid FROM pg_index
    WHERE indexrelid = to_regclass(${indexName})`;
  assert.equal(index?.indisvalid, true, "retry must replace the invalid index");
  const [pending] = await sql`SELECT max(created_at)::text AS latest
    FROM drizzle.__drizzle_migrations`;
  const [deadline] = await sql`SHOW statement_timeout`;
  assert.equal(deadline?.statement_timeout, "2s");
  await sql`ALTER TABLE chat_threads DROP CONSTRAINT test_abort_backfill`;
  const timings = [];
  for (const cursor of [
    null,
    "10000000-0000-4000-8000-0000000002ee",
    "10000000-0000-4000-8000-0000000005dc",
  ]) {
    const plan = summarizeMigrationPlan(
      await sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${batch}`, [
        cursor,
      ]),
    );
    const lookups = plan.nodes.filter(({ measurements }) => {
      assert.notEqual(
        measurements["Index Name"],
        "idx_agent_runs_org",
        "a per-Thread lookup must not repeatedly scan the organization index",
      );
      return measurements["Index Name"] === indexName;
    });
    assert.ok(lookups.length > 0);
    for (const { measurements } of lookups) {
      assert.ok(
        measurements["Actual Rows"] !== undefined &&
          measurements["Actual Rows"] <= 1,
        "the ordered lookup stops at one Run",
      );
    }
    timings.push(plan.executionMs);
  }
  const completedPrefix = await sql`SELECT id, xmin::text FROM chat_threads
    WHERE agent_id = ${agentId} ORDER BY id`;
  await applyPendingMigrations(sql);
  assert.deepEqual(
    await sql`SELECT id, xmin::text FROM chat_threads
      WHERE agent_id = ${agentId} ORDER BY id`,
    completedPrefix,
    "retry must not physically rewrite already reconciled Threads",
  );
  const [finished] = await sql`SELECT max(created_at)::text AS latest
    FROM drizzle.__drizzle_migrations`;
  assert.notEqual(finished?.latest, pending?.latest);
  const [removed] = await sql`SELECT to_regclass(${indexName}) AS name`;
  assert.equal(removed?.name, null);
  console.log(
    JSON.stringify({
      scenario: "skewed-thread-predecessor-backfill",
      organizations: 1502,
      hotThreadRuns: hotRunCount,
      batchExecutionMs: timings,
      recovery: "invalid-index replacement and committed-prefix replay passed",
    }),
  );
}

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
  const entry = journal.entries.find(({ tag }) => {
    return tag === "1452_backfill_thread_executed_predecessor";
  });
  assert.ok(entry);
  const source = await readFile(
    new URL(`../src/migrations/${entry.tag}.sql`, import.meta.url),
    "utf8",
  );
  const batch = source.split("--> statement-breakpoint").find((statement) => {
    return statement.includes("-- okou:batch-by-uuid");
  });
  assert.ok(batch);
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  await applyPendingMigrations(sql, { beforeMillis: entry.when });
  await seedSkewedHistory();
  await assertRetryAndPlans(batch);
  await assertReconciled();
  const before = await sql`SELECT id, xmin::text FROM chat_threads ORDER BY id`;
  await applyPendingMigrations(sql);
  assert.deepEqual(
    await sql`SELECT id, xmin::text FROM chat_threads ORDER BY id`,
    before,
  );
} finally {
  await sql.end();
  await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
  await admin.end();
}
