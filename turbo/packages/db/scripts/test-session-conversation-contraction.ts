import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, DatabaseError, Query } from "pg";
import postgres from "postgres";
import { z } from "zod";

import { agentRuns } from "../src/runtime/agent-run";
import { chatThreads } from "../src/runtime/chat-thread";
import { applyPendingMigrations } from "./migration-runner";

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
const contraction = journal.entries.find((entry) => {
  return entry.tag.endsWith("_contract_session_conversation");
});
assert.ok(contraction);

const databaseName = `session_contraction_${randomUUID().replaceAll("-", "")}`;
const admin = new Client({ connectionString: databaseUrl });
await admin.connect();
await admin.query(`CREATE DATABASE "${databaseName}"`);
const url = new URL(databaseUrl);
url.pathname = `/${databaseName}`;
const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
const client = new Client({ connectionString: url.toString() });
const agentId = randomUUID();
const threadId = randomUUID();
const sessionId = randomUUID();
const runId = randomUUID();
const activeRunId = randomUUID();
const storageId = randomUUID();
const hash = "a".repeat(64);
const snapshot = {
  schemaVersion: 5,
  framework: "pi",
  runnerProfile: "test",
} as const;

async function retainedState() {
  return {
    runs: Array.from(
      await sql`SELECT to_jsonb(r) - ARRAY['session_id', 'continued_from_session_id'] AS row FROM agent_runs r ORDER BY id`,
    ),
    threads: Array.from(
      await sql`SELECT (to_jsonb(t) - ARRAY['agent_session_id', 'agent_session_run_id'])
        || jsonb_build_object('hidden', COALESCE(to_jsonb(t)->'hidden', 'false'::jsonb)) AS row
        FROM chat_threads t ORDER BY id`,
    ),
    events: Array.from(
      await sql`SELECT to_jsonb(e) AS row FROM chat_events e ORDER BY id`,
    ),
    candidates: Array.from(
      await sql`SELECT to_jsonb(c) AS row FROM pi_memory_stage1_candidates c ORDER BY memory_storage_id, pi_session_id`,
    ),
    blobs: Array.from(
      await sql`SELECT to_jsonb(b) AS row FROM blobs b ORDER BY hash`,
    ),
    storages: Array.from(
      await sql`SELECT to_jsonb(s) AS row FROM storages s ORDER BY id`,
    ),
  };
}

async function withPausedCopy(
  text: string,
  check: () => Promise<void>,
): Promise<void> {
  const blocker = new Client({ connectionString: url.toString() });
  await blocker.connect();
  try {
    const backend = await blocker.query<{ pid: unknown }>(
      "SELECT pg_backend_pid() AS pid",
    );
    const pid = backend.rows[0]?.pid;
    assert.ok(typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0);

    class PausedCopy extends Query<Record<string, unknown>, []> {
      paused = false;

      handleCopyData(message: { chunk: unknown }): void {
        if (!this.paused) {
          this.paused = true;
          blocker.connection.stream.pause();
          this.emit("firstCopyData", message.chunk);
        }
      }
    }

    const resource = new PausedCopy(text);
    let ended = false;
    const outcome = new Promise<unknown>((resolve) => {
      resource.once("error", (error: unknown) => {
        ended = true;
        resolve(error);
      });
      resource.once("end", () => {
        ended = true;
        resolve(new Error("COPY completed before cancellation"));
      });
    });
    const ready = Promise.race([
      new Promise<unknown>((resolve) => {
        resource.once("firstCopyData", resolve);
      }),
      outcome.then((error) => {
        throw error;
      }),
    ]);
    try {
      blocker.query(resource);
      assert.ok(Buffer.isBuffer(await ready));
      assert.equal(ended, false);
      await check();
    } finally {
      let cancelled = false;
      try {
        if (!ended) {
          const result = await client.query<{ cancelled: unknown }>(
            "SELECT pg_cancel_backend($1) AS cancelled",
            [pid],
          );
          assert.equal(result.rows[0]?.cancelled, true);
          cancelled = true;
        }
      } finally {
        blocker.connection.stream.resume();
      }
      const error = await outcome;
      if (cancelled) {
        assert.ok(error instanceof DatabaseError);
        assert.equal(error.code, "57014");
      }
    }
  } finally {
    await blocker.end();
  }
}

try {
  await applyPendingMigrations(sql, { beforeMillis: contraction.when });
  await client.connect();
  const db = drizzle(client);
  await sql`INSERT INTO agents (id, org_id, owner, name) VALUES (${agentId}, 'org-contraction', 'user-contraction', 'retained-agent')`;
  await sql`INSERT INTO agent_sessions (id, user_id, org_id, agent_id) VALUES (${sessionId}, 'user-contraction', 'org-contraction', ${agentId})`;
  await sql`INSERT INTO chat_threads (id, user_id, agent_id, agent_session_id, agent_session_run_id, framework, framework_session_id, framework_session_run_id)
    VALUES (${threadId}, 'user-contraction', ${agentId}, ${sessionId}, ${runId}, 'pi', ${threadId}, ${runId})`;
  await sql`INSERT INTO agent_runs (id, user_id, org_id, agent_id, session_id, continued_from_session_id, status, prompt, framework, framework_session_id, legacy_conversation_history_hash, chat_thread_id, trigger_source, autonomy_budget)
    VALUES (${runId}, 'user-contraction', 'org-contraction', ${agentId}, ${sessionId}, ${sessionId}, 'completed', 'retained historical input', 'pi', ${threadId}, ${hash}, ${threadId}, 'web', 0)`;
  await sql`INSERT INTO conversations (run_id, cli_agent_type, cli_agent_session_id, cli_agent_session_history_hash, cli_agent_session_history)
    VALUES (${runId}, 'pi', ${threadId}, ${hash}, 'obsolete inline history')`;
  await sql`UPDATE agent_sessions SET conversation_id = (SELECT id FROM conversations WHERE run_id = ${runId}) WHERE id = ${sessionId}`;
  await sql`INSERT INTO blobs (hash, raw_size, encoding, encoded_size, ref_count) VALUES (${hash}, 10, 'identity', 10, 2)`;
  await sql`INSERT INTO storages (id, org_id, user_id, name, s3_prefix) VALUES (${storageId}, 'org-contraction', 'user-contraction', 'memory', 'memory-owned-input')`;
  await sql`INSERT INTO pi_memory_stage1_candidates (memory_storage_id, org_id, user_id, pi_session_id, source_run_id, source_history_hash, source_completed_at, eligible_at)
    VALUES (${storageId}, 'org-contraction', 'user-contraction', ${threadId}, ${runId}, ${hash}, now(), now())`;
  await sql`INSERT INTO chat_events (chat_thread_id, run_id, event_type, context_type, seq_id, payload)
    VALUES (${threadId}, ${runId}, 'input.prompt', 'web', 1, ${sql.json({ userMessage: { version: 1, parts: [{ type: "text", text: "durable public Chat" }] } })})`;
  await db.insert(agentRuns).values({
    id: activeRunId,
    userId: "user-contraction",
    orgId: "org-contraction",
    agentId,
    status: "running",
    prompt: "native-only continuation",
    launchSnapshot: snapshot,
  });

  const baseline = await retainedState();
  const journalBefore = Array.from(
    await sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`,
  );
  const assertUnchanged = async () => {
    assert.deepEqual(await retainedState(), baseline);
    assert.deepEqual(
      Array.from(
        await sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`,
      ),
      journalBefore,
    );
    assert.equal(
      (await sql`SELECT count(*)::int AS count FROM conversations`)[0]?.count,
      1,
    );
    assert.equal(
      (await sql`SELECT count(*)::int AS count FROM agent_sessions`)[0]?.count,
      1,
    );
    assert.equal(
      (
        await sql`SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema = 'public' AND (
          (table_name = 'agent_runs' AND column_name IN ('session_id', 'continued_from_session_id')) OR
          (table_name = 'chat_threads' AND column_name IN ('agent_session_id', 'agent_session_run_id'))
        )`
      )[0]?.count,
      4,
    );
  };
  const rejectWithoutMutation = async (expected: RegExp) => {
    await assert.rejects(applyPendingMigrations(sql), expected);
    await assertUnchanged();
  };

  await sql`UPDATE agent_runs SET launch_snapshot = ${sql.json({ ...snapshot, schemaVersion: 3 })} WHERE id = ${activeRunId}`;
  await assert.rejects(
    applyPendingMigrations(sql),
    /requires legacy Run drain/,
  );
  await sql`UPDATE agent_runs SET launch_snapshot = ${sql.json(snapshot)} WHERE id = ${activeRunId}`;
  await sql`UPDATE agent_runs SET framework = NULL WHERE id = ${runId}`;
  await assert.rejects(
    applyPendingMigrations(sql),
    /native facts were not transferred/,
  );
  await sql`UPDATE agent_runs SET framework = 'pi' WHERE id = ${runId}`;

  await sql`CREATE INDEX unexpected_session_index ON agent_runs (continued_from_session_id)`;
  await rejectWithoutMutation(/Unexpected Session\/Conversation column index/);
  await sql`DROP INDEX unexpected_session_index`;
  await sql`CREATE INDEX unexpected_session_expression ON agent_runs ((continued_from_session_id::text)) WHERE session_id IS NOT NULL`;
  await rejectWithoutMutation(/Unexpected Session\/Conversation column index/);
  await sql`DROP INDEX unexpected_session_expression`;
  await sql`CREATE FUNCTION public.untracked_session_reader() RETURNS bigint LANGUAGE sql AS 'SELECT count(*) FROM public.agent_sessions'`;
  await rejectWithoutMutation(
    /Unexpected routine referencing Session\/Conversation/,
  );
  await sql`DROP FUNCTION public.untracked_session_reader()`;
  await sql`CREATE FUNCTION public.untracked_run_reader() RETURNS jsonb LANGUAGE sql AS 'SELECT to_jsonb(r) FROM public.agent_runs r LIMIT 1'`;
  await rejectWithoutMutation(
    /Unexpected routine referencing Session\/Conversation/,
  );
  await sql`DROP FUNCTION public.untracked_run_reader()`;
  await sql`CREATE VIEW unexpected_session_reader AS SELECT session_id FROM agent_runs`;
  await rejectWithoutMutation(/depend on it/);
  await sql`DROP VIEW unexpected_session_reader`;

  await sql`SET transaction_timeout = '30s'`;
  try {
    await rejectWithoutMutation(/transaction_timeout initially disabled/);
  } finally {
    await sql`RESET transaction_timeout`;
  }

  // A streaming SELECT holds Thread's normal read lock without an explicit
  // transaction. Run's earlier DDL must roll back when the later lock is busy.
  await withPausedCopy(
    `COPY (
      SELECT id, ordinal, repeat('x', 8192)
      FROM chat_threads CROSS JOIN generate_series(1, 8192) AS ordinal
      WHERE id = '${threadId}'
    ) TO STDOUT`,
    async () => {
      await rejectWithoutMutation(/lock timeout/);
    },
  );

  // Inject execution latency only into future journal writes. This is not lock
  // waiting (which has its own shorter deadline), so it proves the server's
  // whole-transaction timer covers the runner after the final DDL statement.
  await sql`ALTER TABLE drizzle.__drizzle_migrations
    ADD CONSTRAINT slow_journal_write CHECK (pg_sleep(3) IS NOT NULL) NOT VALID`;
  try {
    // A transaction timeout terminates the connection. Exercise the real CLI
    // in its own process, then verify rollback from a surviving connection.
    const migration = spawn(
      process.execPath,
      ["--import", "tsx", "scripts/migrate.ts"],
      { env: { ...process.env, DATABASE_URL: url.toString() } },
    );
    let stderr = "";
    migration.stdout.resume();
    migration.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-16_384);
    });
    let finished = false;
    const completion = new Promise<number | null>((resolve) => {
      migration.once("error", (error) => {
        finished = true;
        stderr += error.message;
        resolve(null);
      });
      migration.once("close", (code) => {
        finished = true;
        resolve(code);
      });
    });
    try {
      const deadline = performance.now() + 15_000;
      while (true) {
        const observed = await client.query<{ sleeping: unknown }>(
          `SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE datname = $1 AND wait_event = 'PgSleep'
              AND query ILIKE '%INSERT INTO%__drizzle_migrations%'
          ) AS sleeping`,
          [databaseName],
        );
        if (observed.rows[0]?.sleeping === true) {
          break;
        }
        assert.equal(
          finished,
          false,
          `Migration exited before journal write: ${stderr}`,
        );
        assert.ok(
          performance.now() < deadline,
          "Migration did not reach journal write",
        );
        await delay(10);
      }
      assert.notEqual(
        await completion,
        0,
        "Slow journal write must fail migration",
      );
    } finally {
      if (!finished) {
        migration.kill("SIGKILL");
        await completion;
      }
    }
    await assertUnchanged();
  } finally {
    await sql`ALTER TABLE drizzle.__drizzle_migrations DROP CONSTRAINT slow_journal_write`;
  }

  const startedAt = performance.now();
  await applyPendingMigrations(sql);
  const elapsedMs = performance.now() - startedAt;
  assert.deepEqual(await retainedState(), baseline);
  assert.deepEqual(
    Array.from(
      await sql`SELECT to_regclass('public.agent_sessions')::text AS sessions, to_regclass('public.conversations')::text AS conversations`,
    ),
    [{ sessions: null, conversations: null }],
  );
  assert.equal(
    (
      await sql`SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema = 'public' AND (
    (table_name = 'agent_runs' AND column_name IN ('session_id', 'continued_from_session_id')) OR
    (table_name = 'chat_threads' AND column_name IN ('agent_session_id', 'agent_session_run_id'))
  )`
    )[0]?.count,
    0,
  );

  // These are the same runtime columns used by the outgoing API. Exercise full
  // SELECT/RETURNING projections after physical deletion, not only explicit SQL.
  const [run] = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, runId));
  assert.equal(run?.legacyConversationHistoryHash, hash);
  assert.equal(run?.agentId, agentId);
  const [thread] = await db
    .update(chatThreads)
    .set({ framework: "pi" })
    .where(eq(chatThreads.id, threadId))
    .returning();
  assert.equal(thread?.frameworkSessionId, threadId);
  const [updated] = await db
    .update(agentRuns)
    .set({ frameworkSessionId: threadId })
    .where(eq(agentRuns.id, activeRunId))
    .returning();
  assert.equal(updated?.frameworkSessionId, threadId);
  assert.equal(
    (await sql`SELECT ref_count FROM blobs WHERE hash = ${hash}`)[0]?.ref_count,
    2,
  );
  const acceptedJournal = Array.from(
    await sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`,
  );
  await applyPendingMigrations(sql);
  assert.deepEqual(
    Array.from(
      await sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`,
    ),
    acceptedJournal,
  );
  console.log(
    `Session/Conversation contraction passed: preserved Run/Thread/Chat/Memory/blob ownership, rejected live legacy Runs and catalog drift, rolled back busy locks and journal timeout, runtime ORM survived; contraction ${Math.round(elapsedMs)}ms`,
  );
} finally {
  await client.end();
  await sql.end();
  await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await admin.end();
}
