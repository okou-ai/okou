import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { array, number, object, string } from "zod";
import { applyPendingMigrations } from "./migration-runner";

const journalSchema = object({
  entries: array(object({ tag: string(), when: number() })),
});

async function retainedState(sql: postgres.Sql) {
  return JSON.stringify(
    Array.from(
      await sql`SELECT jsonb_build_object(
      'agent', (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM agents a),
      'thread', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM chat_threads t),
      'run', (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM agent_runs r),
      'billing', (SELECT jsonb_agg(to_jsonb(b) ORDER BY run_id) FROM billing_run_attribution b),
      'usage', (SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM usage_event u),
      'wallet', (SELECT jsonb_agg(to_jsonb(o) ORDER BY org_id) FROM org_metadata o)
    ) AS state`,
    ),
  );
}

async function migrationJournal(sql: postgres.Sql) {
  return Array.from(
    await sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`,
  );
}

/** Exercise the real contraction against retained business state and consumers. */
export async function validateRunnerJobQueueRetirement(databaseUrl: string) {
  const journal = journalSchema.parse(
    JSON.parse(
      await readFile(
        new URL("../src/migrations/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const retirement = journal.entries.find((entry) => {
    return entry.tag === "1553_retire_runner_job_queue";
  });
  assert.ok(retirement, "Missing Runner queue retirement migration");

  const admin = postgres(databaseUrl, { max: 1 });
  const baselineName = `queue_retirement_base_${randomUUID().replaceAll("-", "")}`;
  const baselineUrl = new URL(databaseUrl);
  baselineUrl.pathname = `/${baselineName}`;
  let baselineCreated = false;
  try {
    await admin.unsafe(`CREATE DATABASE "${baselineName}"`);
    baselineCreated = true;
    const baseline = postgres(baselineUrl.toString(), { max: 1 });
    try {
      await applyPendingMigrations(baseline, { beforeMillis: retirement.when });
      await baseline`INSERT INTO org_metadata (org_id, credits)
        VALUES ('queue-retirement-org', 123456)`;
      await baseline`INSERT INTO agents (id, org_id, owner, name)
        VALUES ('11111111-1111-4111-8111-111111111111', 'queue-retirement-org',
          'queue-owner', 'queue-retirement-fixture')`;
      await baseline`INSERT INTO chat_threads (id, user_id, agent_id)
        VALUES ('22222222-2222-4222-8222-222222222222', 'queue-owner',
          '11111111-1111-4111-8111-111111111111')`;
      await baseline`INSERT INTO agent_runs
        (id, user_id, org_id, agent_id, chat_thread_id, status, prompt, result,
          trigger_source, autonomy_budget,
          created_at, completed_at)
        VALUES ('33333333-3333-4333-8333-333333333333', 'queue-owner',
          'queue-retirement-org', '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222', 'completed',
          'Preserved execution input', '{"text":"Preserved result"}', 'web', 0,
          '2026-11-14T01:00:00Z', '2026-11-14T01:01:00Z')`;
      await baseline`INSERT INTO billing_run_attribution
        (run_id, org_id, user_id, run_started_at, source, thread_id,
          thread_context, usage_observed, run_terminal_status, run_completed_at,
          run_lifecycle_context)
        SELECT id, org_id, user_id, created_at, 'chat', chat_thread_id,
          'thread', true, status, completed_at, 'captured' FROM agent_runs`;
      await baseline`INSERT INTO usage_event
        (idempotency_key, run_id, billing_run_id, billing_anchor_at,
          billing_context, org_id, user_id, kind, provider, category, quantity,
          credits_charged, status, processed_at)
        SELECT '44444444-4444-4444-8444-444444444444'::uuid, id, id, created_at, 'run', org_id,
          user_id, 'model', 'retained-provider', 'input', 100, 7, 'processed',
          completed_at FROM agent_runs`;
    } finally {
      await baseline.end();
    }

    for (const scenario of [
      "success",
      "queued-work",
      "view",
      "foreign-key",
      "local-index",
      "local-check",
      "unexpected-default",
      "string-bodied-function",
      "local-trigger",
      "inheritance",
      "row-array-consumer",
    ]) {
      const name = `queue_retirement_${randomUUID().replaceAll("-", "")}`;
      const url = new URL(databaseUrl);
      url.pathname = `/${name}`;
      await admin.unsafe(
        `CREATE DATABASE "${name}" TEMPLATE "${baselineName}"`,
      );
      const sql = postgres(url.toString(), { max: 1 });
      try {
        const original = await retainedState(sql);
        const originalJournal = await migrationJournal(sql);
        if (scenario === "success") {
          await applyPendingMigrations(sql, {
            beforeMillis: retirement.when + 1,
          });
          assert.equal(await retainedState(sql), original);
          const applied = await migrationJournal(sql);
          assert.equal(applied.length, originalJournal.length + 1);
          assert.equal(applied.at(-1)?.created_at, String(retirement.when));
          const runId = randomUUID();
          assert.deepEqual(
            Array.from(
              await sql`INSERT INTO agent_runs
              (id, user_id, org_id, status, prompt, trigger_source, autonomy_budget)
              VALUES (${runId}, 'queue-owner', 'queue-retirement-org',
                'pending', 'Current execution after contraction', 'web', 0) RETURNING id`,
            ),
            [{ id: runId }],
          );
          await sql`INSERT INTO usage_event
            (idempotency_key, org_id, user_id, kind, provider, category, quantity)
            VALUES (gen_random_uuid(), 'queue-retirement-org',
              'queue-owner', 'model', 'retained-provider', 'input', 50)`;
          const afterWrite = await retainedState(sql);
          await applyPendingMigrations(sql, {
            beforeMillis: retirement.when + 1,
          });
          assert.deepEqual(await migrationJournal(sql), applied);
          assert.equal(await retainedState(sql), afterWrite);
          continue;
        }
        if (scenario === "queued-work")
          await sql`INSERT INTO runner_job_queue
            (run_id, runner_group, execution_context, expires_at)
            VALUES ('33333333-3333-4333-8333-333333333333', 'retained-group',
              '{"captured":"Preserve unresolved execution input"}',
              '2026-11-15T01:00:00Z')`;
        if (scenario === "view")
          await sql`CREATE VIEW queue_consumer AS SELECT * FROM runner_job_queue`;
        if (scenario === "foreign-key")
          await sql`CREATE TABLE queue_consumer
            (run_id uuid REFERENCES runner_job_queue(run_id))`;
        if (scenario === "local-index")
          await sql`CREATE INDEX queue_consumer ON runner_job_queue(created_at)`;
        if (scenario === "local-check")
          await sql`ALTER TABLE runner_job_queue ADD CONSTRAINT queue_consumer
            CHECK (runner_group <> '')`;
        if (scenario === "unexpected-default")
          await sql`ALTER TABLE runner_job_queue ALTER COLUMN reuse_key
            SET DEFAULT 'unexpected-owner'`;
        if (scenario === "string-bodied-function")
          await sql`CREATE FUNCTION queue_count() RETURNS bigint LANGUAGE sql
            AS 'SELECT count(*) FROM public.runner_job_queue'`;
        if (scenario === "local-trigger") {
          await sql`CREATE FUNCTION queue_trigger() RETURNS trigger LANGUAGE plpgsql
            AS 'BEGIN RETURN NEW; END'`;
          await sql`CREATE TRIGGER queue_consumer BEFORE INSERT ON runner_job_queue
            FOR EACH ROW EXECUTE FUNCTION queue_trigger()`;
        }
        if (scenario === "inheritance")
          await sql`CREATE TABLE queue_consumer () INHERITS (runner_job_queue)`;
        if (scenario === "row-array-consumer")
          await sql`CREATE TABLE queue_consumer (captured runner_job_queue[])`;

        const state = async () => {
          return JSON.stringify([
            await retainedState(sql),
            Array.from(
              await sql`SELECT * FROM runner_job_queue ORDER BY run_id`,
            ),
            await migrationJournal(sql),
          ]);
        };
        const before = await state();
        await assert.rejects(
          applyPendingMigrations(sql, { beforeMillis: retirement.when + 1 }),
          { code: scenario === "queued-work" ? "23514" : "2BP01" },
        );
        assert.equal(await state(), before, scenario);
      } finally {
        try {
          await sql.end();
        } finally {
          await admin.unsafe(`DROP DATABASE "${name}"`);
        }
      }
    }
  } finally {
    try {
      if (baselineCreated)
        await admin.unsafe(`DROP DATABASE "${baselineName}"`);
    } finally {
      await admin.end();
    }
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  await validateRunnerJobQueueRetirement(process.env.DATABASE_URL);
  console.log(
    "Runner queue contraction preserves business data and rejects unresolved consumers",
  );
}
