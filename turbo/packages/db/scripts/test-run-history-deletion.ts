import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import postgres from "postgres";
import { PgDialect, QueryBuilder } from "drizzle-orm/pg-core";
import { z } from "zod";
import { applyFixtureMigrations } from "./fixtures/migrate-with-empty-instructions";
import { agentRuns } from "../src/runtime/agent-run";
import {
  agentRunDeletionMembership,
  deletedRunHistorySchema,
  deleteRunHistoriesSql,
} from "./fixtures/run-history-deletion-prepared";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const databaseName = `run_history_deletion_${randomUUID().replaceAll("-", "")}`;
const admin = new Client({ connectionString: databaseUrl });
const url = new URL(databaseUrl);
url.pathname = `/${databaseName}`;
await admin.connect();
await admin.query(`CREATE DATABASE "${databaseName}"`);
const migrationClient = postgres(url.toString(), {
  max: 1,
  onnotice: () => {},
});
const client = new Client({ connectionString: url.toString() });
const writer = new Client({ connectionString: url.toString() });
const dialect = new PgDialect();
const a = "a".repeat(64);
const b = "b".repeat(64);

async function requireWait(pid: number, event: "Lock" | "PgSleep") {
  const deadline = Date.now() + 5000;
  let waiting = false;
  while (!waiting && Date.now() < deadline) {
    const state = await admin.query(
      "SELECT (wait_event_type = $2 OR wait_event = $2) AS waiting FROM pg_stat_activity WHERE pid = $1",
      [pid, event],
    );
    waiting =
      z
        .array(z.object({ waiting: z.boolean().nullable() }))
        .parse(state.rows)[0]?.waiting === true;
    if (!waiting)
      await new Promise((resolve) => {
        return setTimeout(resolve, 10);
      });
  }
  assert.ok(waiting, "Observe the actual writer wait before committing");
}

async function remove(ids: readonly string[]) {
  const query = dialect.sqlToQuery(deleteRunHistoriesSql(ids));
  return z
    .array(deletedRunHistorySchema)
    .parse((await client.query(query.sql, query.params)).rows);
}

async function fixture(args: {
  readonly agentId: string;
  readonly sessionId: string | null;
  readonly framework: string | null;
  readonly mirror: string | null;
  readonly conversation?: string | null;
}) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO agent_runs (id, user_id, org_id, agent_id, session_id, status, prompt, framework, legacy_conversation_history_hash)
     VALUES ($1, 'user-history', 'org-history', $2, $3, 'completed', 'retain history', $4, $5)`,
    [id, args.agentId, args.sessionId, args.framework, args.mirror],
  );
  if (args.conversation !== undefined) {
    await client.query(
      `INSERT INTO conversations (run_id, cli_agent_type, cli_agent_session_id, cli_agent_session_history_hash)
       VALUES ($1::uuid, 'pi', $1::text, $2)`,
      [id, args.conversation],
    );
  }
  return id;
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
  const cutover = journal.entries.find((entry) => {
    return entry.tag.endsWith("_retire_session_conversation_runtime");
  });
  assert.ok(cutover);
  await applyFixtureMigrations(migrationClient, { beforeMillis: cutover.when });
  await client.connect();
  await writer.connect();
  const [writerBackend] = z
    .array(z.object({ pid: z.number() }))
    .parse((await writer.query("SELECT pg_backend_pid() AS pid")).rows);
  assert.ok(writerBackend);
  const agentId = randomUUID();
  const otherAgentId = randomUUID();
  const sessionId = randomUUID();
  await client.query(
    `INSERT INTO agents (id, org_id, owner, name) VALUES
      ($1, 'org-history', 'user-history', 'target-history'),
      ($2, 'org-history', 'user-history', 'surviving-history')`,
    [agentId, otherAgentId],
  );
  await client.query(
    "INSERT INTO agent_sessions (id, user_id, org_id, agent_id) VALUES ($1, 'user-history', 'org-history', $2)",
    [sessionId, agentId],
  );
  const old = await fixture({
    agentId,
    sessionId,
    framework: null,
    mirror: null,
    conversation: a,
  });
  // Replay the physical cutover shape in this disposable database only. This
  // preparation release must not ship the nullable Session column itself.
  await client.query(
    "ALTER TABLE agent_runs ALTER COLUMN session_id DROP NOT NULL",
  );
  const mirrored = await fixture({
    agentId,
    sessionId,
    framework: "pi",
    mirror: a,
    conversation: a,
  });
  const replaced = await fixture({
    agentId,
    sessionId,
    framework: "pi",
    mirror: b,
    conversation: a,
  });
  const cleared = await fixture({
    agentId,
    sessionId,
    framework: "pi",
    mirror: null,
    conversation: a,
  });
  const native = await fixture({
    agentId,
    sessionId: null,
    framework: "pi",
    mirror: null,
  });
  const surviving = await fixture({
    agentId: otherAgentId,
    sessionId: null,
    framework: "pi",
    mirror: b,
  });
  await client.query("UPDATE agent_runs SET agent_id = NULL WHERE id = $1", [
    old,
  ]);

  const members = new QueryBuilder()
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(agentRunDeletionMembership([agentId]))
    .getSQL();
  const membershipQuery = dialect.sqlToQuery(members);
  const membership = z
    .array(z.object({ id: z.uuid() }))
    .parse(
      (await client.query(membershipQuery.sql, membershipQuery.params)).rows,
    );
  assert.deepEqual(
    new Set(
      membership.map((row) => {
        return row.id;
      }),
    ),
    new Set([old, mirrored, replaced, cleared, native]),
  );
  // A live native Run is in the actual deletion admission set even without a Session.
  await client.query("UPDATE agent_runs SET status = 'running' WHERE id = $1", [
    native,
  ]);
  const active = new QueryBuilder()
    .select({ status: agentRuns.status })
    .from(agentRuns)
    .where(agentRunDeletionMembership([agentId]))
    .getSQL();
  const activeQuery = dialect.sqlToQuery(active);
  assert.ok(
    z
      .array(z.object({ status: z.string() }))
      .parse((await client.query(activeQuery.sql, activeQuery.params)).rows)
      .some((row) => {
        return row.status === "running";
      }),
  );
  await client.query(
    "UPDATE agent_runs SET status = 'completed' WHERE id = $1",
    [native],
  );

  const removed = await remove([old, mirrored, replaced, cleared, native]);
  assert.deepEqual(
    new Map(
      removed.map(({ id, hash, hadConversation }) => {
        return [id, { hash, hadConversation }];
      }),
    ),
    new Map([
      [old, { hash: a, hadConversation: true }],
      [mirrored, { hash: a, hadConversation: true }],
      [replaced, { hash: b, hadConversation: true }],
      [cleared, { hash: null, hadConversation: true }],
      [native, { hash: null, hadConversation: false }],
    ]),
  );
  assert.equal((await client.query("SELECT 1 FROM conversations")).rowCount, 0);
  assert.equal(
    (await client.query("SELECT 1 FROM agent_runs WHERE id = $1", [surviving]))
      .rowCount,
    1,
  );
  assert.deepEqual(await remove([old]), []);
  assert.deepEqual(await remove([]), []);

  // The same prepared row can finish with a different held hash while DELETE
  // waits. RETURNING must use that winning row, rather than an earlier read.
  const concurrent = await fixture({
    agentId,
    sessionId,
    framework: "pi",
    mirror: a,
    conversation: a,
  });
  const update = writer.query(
    "UPDATE agent_runs SET legacy_conversation_history_hash = $2 WHERE id = $1 RETURNING pg_sleep(1)",
    [concurrent, b],
  );
  void update.catch(() => {});
  const [backend] = z
    .array(z.object({ pid: z.number() }))
    .parse((await client.query("SELECT pg_backend_pid() AS pid")).rows);
  assert.ok(backend);
  const pid = backend.pid;
  await requireWait(writerBackend.pid, "PgSleep");
  const deletion = remove([concurrent]);
  // Attach a rejection handler immediately while the observer inspects the wait.
  void deletion.catch(() => {});
  await requireWait(pid, "Lock");
  await update;
  assert.deepEqual(await deletion, [
    { id: concurrent, hash: b, hadConversation: true },
  ]);

  // Preserve the outgoing SET NULL FK. A retained direct Run remains
  // visible by immutable org ownership after the cascade;
  // Clerk's fresh post-parent check must reject this partial erasure.
  const lateAgent = randomUUID();
  const lateRun = randomUUID();
  await client.query(
    "INSERT INTO agents (id, org_id, owner, name) VALUES ($1, 'org-late-history', 'user-late-history', 'late-history')",
    [lateAgent],
  );
  await client.query(
    "INSERT INTO agent_runs (id, user_id, org_id, agent_id, status, prompt) VALUES ($1, 'user-late-history', 'org-late-history', $2, 'pending', 'late native admission')",
    [lateRun, lateAgent],
  );
  const parentDeletion = await client.query(
    "DELETE FROM agents WHERE id = $1",
    [lateAgent],
  );
  assert.equal(parentDeletion.rowCount, 1);
  assert.deepEqual(
    z
      .array(
        z.object({
          id: z.uuid(),
          agent_id: z.null(),
          user_id: z.literal("user-late-history"),
        }),
      )
      .parse(
        (
          await client.query(
            "SELECT id, agent_id, user_id FROM agent_runs WHERE org_id = 'org-late-history'",
          )
        ).rows,
      ),
    [{ id: lateRun, agent_id: null, user_id: "user-late-history" }],
  );

  const index = await client.query(
    "SELECT indexdef FROM pg_indexes WHERE tablename = 'agent_runs' AND indexname = 'idx_agent_runs_agent'",
  );
  assert.equal(index.rowCount, 1);
  console.log(
    "Run deletion supports both ownership shapes and returns historical, mirrored and winning-row references exactly once.",
  );
} finally {
  await writer.end();
  await client.end();
  await migrationClient.end();
  await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await admin.end();
}
