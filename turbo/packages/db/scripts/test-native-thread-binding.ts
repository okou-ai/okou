import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import postgres from "postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import { z } from "zod";
import { nativeThreadBindingSql } from "../src/operations/native-thread-binding";
import { applyFixtureMigrations } from "./fixtures/migrate-with-empty-instructions";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required (disposable PostgreSQL only)");
const name = `native_thread_binding_${randomUUID().replaceAll("-", "")}`;
const admin = new Client({ connectionString: databaseUrl });
await admin.connect();
await admin.query(`CREATE DATABASE "${name}"`);
const url = new URL(databaseUrl);
url.pathname = `/${name}`;
const migrations = postgres(url.toString(), { max: 1, onnotice: () => {} });
const client = new Client({ connectionString: url.toString() });
const publisher = new Client({ connectionString: url.toString() });
const releaser = new Client({ connectionString: url.toString() });
const holder = new Client({ connectionString: url.toString() });
const clients = [client, publisher, releaser, holder];
const dialect = new PgDialect();
const agentId = randomUUID();
const owner = { userId: "native-user", orgId: "native-org" };

function track<T>(promise: Promise<T>) {
  return promise.then(
    (value) => {
      return { ok: true, value } as const;
    },
    (error: unknown) => {
      return { ok: false, error } as const;
    },
  );
}

async function backend(client: Client) {
  const [row] = z
    .array(z.object({ pid: z.number() }))
    .parse((await client.query("SELECT pg_backend_pid() AS pid")).rows);
  assert.ok(row);
  return row.pid;
}

async function requireWait(pid: number, blocker?: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const [row] = z.array(z.object({ waiting: z.boolean().nullable() })).parse(
      (
        await admin.query(
          `SELECT CASE WHEN $2::int IS NULL THEN wait_event = 'PgSleep'
        ELSE $2::int = ANY(pg_blocking_pids(pid)) END AS waiting
       FROM pg_stat_activity WHERE pid = $1`,
          [pid, blocker ?? null],
        )
      ).rows,
    );
    if (row?.waiting) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  assert.fail(
    "Expected the actual PostgreSQL wait before releasing the competing writer",
  );
}

async function fixture(threadId = randomUUID()) {
  const runId = randomUUID();
  await client.query(
    `INSERT INTO chat_threads (id, user_id, agent_id, title)
    VALUES ($1, 'native-user', $2, 'Native binding') ON CONFLICT DO NOTHING`,
    [threadId, agentId],
  );
  await client.query(
    `INSERT INTO agent_runs (id, user_id, org_id, agent_id, status,
    prompt, chat_thread_id, framework, framework_session_id, trigger_source, autonomy_budget)
    VALUES ($1, 'native-user', 'native-org', $2, 'running', 'Input', $3::uuid, 'pi', $3::text, 'web', 32)`,
    [runId, agentId, threadId],
  );
  return { id: runId, chatThreadId: threadId, agentId };
}

async function activate(run: Awaited<ReturnType<typeof fixture>>) {
  await client.query(
    `INSERT INTO active_agent_runs (run_id, user_id, org_id, chat_thread_id, last_heartbeat_at)
    VALUES ($1, 'native-user', 'native-org', $2, '2026-10-20 00:00:00')`,
    [run.id, run.chatThreadId],
  );
}

function publication(
  run: Awaited<ReturnType<typeof fixture>>,
  options: {
    readonly owner?: typeof owner;
    readonly framework?: string;
    readonly sessionId?: string;
  } = {},
) {
  const statement = nativeThreadBindingSql({
    run,
    owner: options.owner ?? owner,
    framework: options.framework ?? "pi",
    sessionId: options.sessionId ?? run.chatThreadId,
  });
  assert.ok(statement);
  return dialect.sqlToQuery(statement);
}

async function publish(
  run: Awaited<ReturnType<typeof fixture>>,
  options: Parameters<typeof publication>[1] = {},
) {
  const query = publication(run, options);
  return (await client.query(query.sql, query.params)).rowCount;
}

async function binding(threadId: string) {
  return z
    .array(
      z.object({
        framework: z.string().nullable(),
        session_id: z.string().nullable(),
        producer_id: z.string().nullable(),
      }),
    )
    .parse(
      (
        await client.query(
          `SELECT framework, framework_session_id AS session_id,
      framework_session_run_id AS producer_id FROM chat_threads WHERE id = $1`,
          [threadId],
        )
      ).rows,
    );
}

try {
  await applyFixtureMigrations(migrations);
  await Promise.all(
    clients.map((connection) => {
      return connection.connect();
    }),
  );
  await client.query(
    `INSERT INTO agents (id, org_id, owner, name)
    VALUES ($1, 'native-org', 'native-user', 'native')`,
    [agentId],
  );
  const first = await fixture();
  await activate(first);
  const activeBefore = (
    await client.query(
      "SELECT to_jsonb(a) AS row FROM active_agent_runs a WHERE run_id = $1",
      [first.id],
    )
  ).rows;
  assert.equal(await publish(first), 1);
  assert.equal(
    await publish(first),
    1,
    "Repeat initialization retains the same producer",
  );
  assert.equal(
    await publish(first, { owner: { ...owner, userId: "foreign-user" } }),
    0,
  );
  assert.equal(
    await publish(first, { owner: { ...owner, orgId: "foreign-org" } }),
    0,
  );
  assert.equal(await publish(first, { framework: "codex" }), 0);
  assert.equal(await publish(first, { sessionId: randomUUID() }), 0);
  assert.deepEqual(
    (
      await client.query(
        "SELECT to_jsonb(a) AS row FROM active_agent_runs a WHERE run_id = $1",
        [first.id],
      )
    ).rows,
    activeBefore,
    "Publication must not change heartbeat, activity or other active state",
  );

  await client.query(
    "UPDATE agent_runs SET status = 'cancelled' WHERE id = $1",
    [first.id],
  );
  assert.equal(
    await publish(first),
    1,
    "Cancellation retains publication authority while its slot remains",
  );
  await client.query("DELETE FROM active_agent_runs WHERE run_id = $1", [
    first.id,
  ]);
  assert.equal(
    await publish(first),
    0,
    "Release before publication denies the old Run",
  );
  const second = await fixture(first.chatThreadId);
  await activate(second);
  assert.equal(await publish(second), 1);
  assert.equal(await publish(first), 0);
  await client.query("DELETE FROM active_agent_runs WHERE run_id = $1", [
    second.id,
  ]);
  await client.query("DELETE FROM agent_runs WHERE id = $1", [second.id]);
  assert.equal(
    await publish(first),
    0,
    "Deleting the newer producer must not restore the old Run's authority",
  );
  assert.deepEqual(await binding(first.chatThreadId), [
    { framework: "pi", session_id: first.chatThreadId, producer_id: second.id },
  ]);

  // Hold the Thread with a real single-statement write. The bounded sleep is
  // cancelled as soon as the exact wait chain is observed; it is not a timing
  // assertion or a new transaction/explicit row-lock path.
  const racing = await fixture();
  await activate(racing);
  const next = await fixture(racing.chatThreadId);
  const holderPid = await backend(holder);
  const publisherPid = await backend(publisher);
  const releaserPid = await backend(releaser);
  const held = track(
    holder.query(
      `WITH held AS (
    UPDATE chat_threads SET title = 'Concurrent title' WHERE id = $1 RETURNING id
  ) SELECT pg_sleep(30) FROM held`,
      [racing.chatThreadId],
    ),
  );
  await requireWait(holderPid);
  const query = publication(racing);
  const published = track(publisher.query(query.sql, query.params));
  await requireWait(publisherPid, holderPid);
  const released = track(
    releaser.query("DELETE FROM active_agent_runs WHERE run_id = $1", [
      racing.id,
    ]),
  );
  await requireWait(releaserPid, publisherPid);
  await admin.query("SELECT pg_cancel_backend($1)", [holderPid]);
  const holding = await held;
  assert.equal(holding.ok, false);
  if (!holding.ok) {
    assert.equal(
      z.object({ code: z.literal("57014") }).safeParse(holding.error).success,
      true,
    );
  }
  const publicationResult = await published;
  const releaseResult = await released;
  assert.ok(publicationResult.ok);
  assert.ok(releaseResult.ok);
  assert.equal(publicationResult.value.rowCount, 1);
  assert.equal(releaseResult.value.rowCount, 1);
  // Admission follows the committed release, as the real queue picker does.
  // The native session ID deliberately stays identical across Runs.
  await activate(next);
  assert.equal(await publish(next), 1);
  assert.equal(await publish(racing), 0);
  assert.deepEqual(await binding(next.chatThreadId), [
    { framework: "pi", session_id: next.chatThreadId, producer_id: next.id },
  ]);
  console.log(
    "Native binding: active identity/ownership, cancellation, producer deletion and observed publication → release → admission ordering passed",
  );
} finally {
  await admin.query(
    "SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE datname = $1",
    [name],
  );
  await Promise.all(
    clients.map((connection) => {
      return connection.end();
    }),
  );
  await migrations.end();
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.end();
}
