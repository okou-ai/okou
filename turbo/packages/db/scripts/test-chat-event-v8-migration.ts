import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { Client } from "pg";
import postgres from "postgres";
import { DRIZZLE_MIGRATE_OUT } from "../drizzle.config";
import { applyPendingMigrations } from "./migration-runner";

// Migration 1282 (Chat Event V8) converges V7 rows in committed batches and
// must be safe to run again after an interrupted or completed attempt. Every
// fixture write targets a fresh, test-owned database, never DATABASE_URL.
const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required for a disposable database");
const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
const fixtureUrl = new URL(adminUrl);
const database = `chat_event_v8_${randomUUID().replaceAll("-", "")}`;
fixtureUrl.pathname = `/${database}`;

const MIGRATION_TAG = "1282_chat_event_v8";
const journal = parseJournal(
  JSON.parse(
    readFileSync(
      new URL("../src/migrations/meta/_journal.json", import.meta.url),
      "utf8",
    ),
  ),
);
const migrationEntry = journal.find((entry) => {
  return entry.tag === MIGRATION_TAG;
});
assert.ok(migrationEntry, `${MIGRATION_TAG} is missing from the journal`);
const migrationMillis = migrationEntry.when;

function parseJournal(value: unknown): { tag: string; when: number }[] {
  assert.ok(typeof value === "object" && value !== null && "entries" in value);
  const entries = value.entries;
  assert.ok(Array.isArray(entries));
  return entries.map((entry: unknown) => {
    assert.ok(
      typeof entry === "object" &&
        entry !== null &&
        "tag" in entry &&
        "when" in entry &&
        typeof entry.tag === "string" &&
        typeof entry.when === "number",
    );
    return { tag: entry.tag, when: entry.when };
  });
}

const AGENT_ID = "00000000-0000-4000-8000-000000127901";
const THREAD_ID = "00000000-0000-4000-8000-000000127902";
const GOAL_CONTEXT_ID = "00000000-0000-4000-8000-000000127903";
const SLACK_CONTEXT_ID = "00000000-0000-4000-8000-000000127904";
const SESSION_ID = "00000000-0000-4000-8000-000000127905";
const USER_ID = "chat-event-v8-user";
const ORG_ID = "chat-event-v8-org";
const GOAL_OUTPUT_ROWS = 6000;

const ids = {
  goalPrompt: "00000000-0000-4000-8000-000000127910",
  goalRejected: "00000000-0000-4000-8000-000000127911",
  goalRevoke: "00000000-0000-4000-8000-000000127912",
  goalOutput: "00000000-0000-4000-8000-000000127913",
  githubPrompt: "00000000-0000-4000-8000-000000127914",
  retiredNotice: "00000000-0000-4000-8000-000000127915",
  slackPrompt: "00000000-0000-4000-8000-000000127916",
  rejectedGoalPart: "00000000-0000-4000-8000-000000127917",
  goalRun: "00000000-0000-4000-8000-000000127920",
  webRun: "00000000-0000-4000-8000-000000127921",
  sharedThread: "00000000-0000-4000-8000-000000127930",
} as const;

const RETIRED_ROWS: readonly {
  readonly eventType: string;
  readonly payload: string | null;
  readonly contextType: string | null;
  readonly contextId: string | null;
  readonly runEventId: string | null;
}[] = [
  {
    eventType: "input.goal",
    payload: JSON.stringify({
      userMessage: {
        version: 1,
        parts: [{ type: "goal", goalBrief: "retired goal input" }],
      },
    }),
    contextType: "goal",
    contextId: GOAL_CONTEXT_ID,
    runEventId: null,
  },
  {
    eventType: "goal.open",
    payload: JSON.stringify({ content: "Ship the goal" }),
    contextType: null,
    contextId: null,
    runEventId: null,
  },
  {
    eventType: "goal.close",
    payload: null,
    contextType: null,
    contextId: null,
    runEventId: null,
  },
  {
    eventType: "run.queued",
    payload: null,
    contextType: "web",
    contextId: null,
    runEventId: "queue:queued",
  },
  {
    eventType: "run.dequeued",
    payload: null,
    contextType: "web",
    contextId: null,
    runEventId: "queue:dequeued",
  },
  {
    eventType: "output.thinking",
    payload: JSON.stringify({ thinking: "reasoning" }),
    contextType: null,
    contextId: null,
    runEventId: "thinking:initial",
  },
  {
    eventType: "browser.open",
    payload: null,
    contextType: null,
    contextId: null,
    runEventId: null,
  },
  {
    eventType: "browser.close",
    payload: null,
    contextType: null,
    contextId: null,
    runEventId: null,
  },
];

function userMessage(parts: readonly object[]): string {
  return JSON.stringify({ userMessage: { version: 1, parts } });
}

async function seedV7(client: Client): Promise<void> {
  await client.query(
    `INSERT INTO agents (id, org_id, owner, name)
     VALUES ($1, $2, $3, 'chat event v8 migration')`,
    [AGENT_ID, ORG_ID, USER_ID],
  );
  await client.query(
    `INSERT INTO chat_threads (id, user_id, agent_id, title)
     VALUES ($1, $2, $3, 'chat event v8 migration')`,
    [THREAD_ID, USER_ID, AGENT_ID],
  );

  let seqId = 0;
  const insertEvent = async (row: {
    readonly id?: string;
    readonly eventType: string;
    readonly payload: string | null;
    readonly contextType: string | null;
    readonly contextId: string | null;
    readonly runEventId?: string | null;
  }): Promise<void> => {
    seqId += 1;
    await client.query(
      `INSERT INTO chat_events (
        id, chat_thread_id, event_type, payload, context_type, context_id,
        run_event_id, seq_id
      ) VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4::jsonb, $5, $6, $7, $8)`,
      [
        row.id ?? null,
        THREAD_ID,
        row.eventType,
        row.payload,
        row.contextType,
        row.contextId,
        row.runEventId ?? null,
        seqId,
      ],
    );
  };

  for (const row of RETIRED_ROWS) {
    await insertEvent(row);
  }
  await insertEvent({
    id: ids.goalPrompt,
    eventType: "input.prompt",
    payload: userMessage([
      { type: "goal", goalBrief: "Keep the launch on track" },
      { type: "model", selectedModel: "claude-sonnet" },
    ]),
    contextType: "goal",
    contextId: GOAL_CONTEXT_ID,
  });
  await insertEvent({
    id: ids.goalRejected,
    eventType: "input.rejected",
    payload: userMessage([{ type: "goal", goalBrief: "Rejected goal turn" }]),
    contextType: "goal",
    contextId: GOAL_CONTEXT_ID,
  });
  await insertEvent({
    id: ids.goalRevoke,
    eventType: "control.revoke",
    payload: null,
    contextType: "goal",
    contextId: GOAL_CONTEXT_ID,
  });
  await insertEvent({
    id: ids.goalOutput,
    eventType: "output.message",
    payload: JSON.stringify({ content: "goal run output" }),
    contextType: "goal",
    contextId: GOAL_CONTEXT_ID,
  });
  await insertEvent({
    id: ids.githubPrompt,
    eventType: "input.prompt",
    payload: userMessage([{ type: "text", text: "from GitHub" }]),
    contextType: "github",
    contextId: GOAL_CONTEXT_ID,
  });
  await insertEvent({
    id: ids.retiredNotice,
    eventType: "output.message",
    payload: JSON.stringify({ content: "Okou Goal retired." }),
    contextType: null,
    contextId: null,
  });
  await insertEvent({
    id: ids.slackPrompt,
    eventType: "input.prompt",
    payload: userMessage([
      { type: "text", text: "from Slack" },
      { type: "source", kind: "slack" },
    ]),
    contextType: "slack",
    contextId: SLACK_CONTEXT_ID,
  });
  await insertEvent({
    id: ids.rejectedGoalPart,
    eventType: "input.rejected",
    payload: userMessage([{ type: "goal", goalBrief: "Web goal part" }]),
    contextType: "web",
    contextId: null,
  });

  // More Goal output rows than one 5000-row primary-key window.
  await client.query(
    `INSERT INTO chat_events (
      chat_thread_id, event_type, payload, context_type, context_id, seq_id
    )
    SELECT $1, 'output.message', jsonb_build_object('content', 'goal output ' || n),
      'goal', $2, $3 + n
    FROM generate_series(1, $4) AS n`,
    [THREAD_ID, GOAL_CONTEXT_ID, seqId, GOAL_OUTPUT_ROWS],
  );

  await client.query(
    `INSERT INTO agent_sessions (id, user_id, org_id, agent_id)
     VALUES ($1, $2, $3, $4)`,
    [SESSION_ID, USER_ID, ORG_ID, AGENT_ID],
  );
  await client.query(
    `INSERT INTO agent_runs (id, user_id, org_id, session_id, status, prompt,
      trigger_source, autonomy_budget)
     VALUES
      ($1, $3, $4, $5, 'completed', 'goal run', 'goal', 0),
      ($2, $3, $4, $5, 'completed', 'web run', 'web', 0)`,
    [ids.goalRun, ids.webRun, USER_ID, ORG_ID, SESSION_ID],
  );
  await client.query(
    `INSERT INTO run_uploaded_files (run_id, source, external_id, user_id, org_id)
     VALUES ($1, 'goal', 'goal-file', $3, $4), ($2, 'web', 'web-file', $3, $4)`,
    [ids.goalRun, ids.webRun, USER_ID, ORG_ID],
  );
  await client.query(
    `INSERT INTO chat_thread_drafts (chat_thread_id, user_id, draft_user_message)
     VALUES ($1, $2, $3::jsonb)`,
    [
      THREAD_ID,
      USER_ID,
      JSON.stringify({
        version: 1,
        parts: [
          { type: "text", text: "draft " },
          { type: "goal", goalBrief: "Draft goal" },
        ],
      }),
    ],
  );
  await client.query(
    `INSERT INTO agent_drafts (user_id, org_id, agent_id, draft_user_message)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [
      USER_ID,
      ORG_ID,
      AGENT_ID,
      JSON.stringify({
        version: 1,
        parts: [{ type: "goal", goalBrief: "Agent draft goal" }],
      }),
    ],
  );
  await client.query(
    `INSERT INTO shared_threads (id, user_id, title, messages)
     VALUES ($1, $2, 'shared', $3::jsonb)`,
    [
      ids.sharedThread,
      USER_ID,
      JSON.stringify([
        { messageIndex: 0, role: "user", content: "hi", runGroupIndex: 0 },
        {
          messageIndex: 1,
          role: "assistant",
          content: "hello",
          runIndex: 0,
          runGroupIndex: 0,
        },
      ]),
    ],
  );
}

async function readState(client: Client): Promise<unknown> {
  const events = await client.query(
    `SELECT id::text, event_type AS "eventType", context_type AS "contextType",
       context_id::text AS "contextId", payload
     FROM chat_events
     WHERE id = ANY($1::uuid[])
     ORDER BY id`,
    [Object.values(ids)],
  );
  const aggregate = await client.query(
    `SELECT event_type AS "eventType", context_type AS "contextType",
       (context_id IS NULL) AS "contextIdIsNull", count(*)::integer AS count
     FROM chat_events
     GROUP BY 1, 2, 3
     ORDER BY 1, 2 NULLS FIRST, 3`,
  );
  const runs = await client.query(
    `SELECT id::text, trigger_source AS "triggerSource"
     FROM agent_runs ORDER BY id`,
  );
  const files = await client.query(
    `SELECT external_id AS "externalId", source
     FROM run_uploaded_files ORDER BY external_id`,
  );
  const drafts = await client.query(
    `SELECT draft_user_message AS document FROM chat_thread_drafts
     UNION ALL
     SELECT draft_user_message FROM agent_drafts`,
  );
  const shares = await client.query(`SELECT messages FROM shared_threads`);
  const constraints = await client.query(
    `SELECT conname AS name, convalidated AS validated
     FROM pg_constraint
     WHERE conrelid = 'public.chat_events'::regclass AND contype = 'c'
     ORDER BY conname`,
  );
  const snapshotVersion = await client.query(
    `SELECT convalidated AS validated,
       pg_get_expr(adbin, adrelid) AS "defaultVersion"
     FROM pg_constraint
     JOIN pg_attrdef ON adrelid = conrelid
     JOIN pg_attribute ON attrelid = adrelid AND attnum = adnum
     WHERE conrelid = 'public.chat_event_snapshots'::regclass
       AND conname = 'chat_event_snapshots_archive_schema_version_check'
       AND attname = 'archive_schema_version'`,
  );
  const helpers = await client.query(
    `SELECT proname FROM pg_proc WHERE proname LIKE 'chat_event_v8_%'`,
  );
  return {
    aggregate: aggregate.rows,
    constraints: constraints.rows,
    drafts: drafts.rows,
    events: events.rows,
    files: files.rows,
    helpers: helpers.rows,
    runs: runs.rows,
    shares: shares.rows,
    snapshotVersion: snapshotVersion.rows,
  };
}

const EXPECTED_EVENTS = [
  {
    id: ids.goalPrompt,
    eventType: "input.prompt",
    contextType: "automation",
    contextId: null,
    payload: {
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text: "Keep the launch on track" },
          { type: "model", selectedModel: "claude-sonnet" },
        ],
      },
    },
  },
  {
    id: ids.goalRejected,
    eventType: "input.rejected",
    contextType: "automation",
    contextId: null,
    payload: {
      userMessage: {
        version: 1,
        parts: [{ type: "text", text: "Rejected goal turn" }],
      },
    },
  },
  {
    id: ids.goalRevoke,
    eventType: "control.revoke",
    contextType: "automation",
    contextId: null,
    payload: null,
  },
  {
    id: ids.goalOutput,
    eventType: "output.message",
    contextType: null,
    contextId: null,
    payload: { content: "goal run output" },
  },
  {
    id: ids.githubPrompt,
    eventType: "input.prompt",
    contextType: "web",
    contextId: null,
    payload: {
      userMessage: {
        version: 1,
        parts: [{ type: "text", text: "from GitHub" }],
      },
    },
  },
  {
    id: ids.retiredNotice,
    eventType: "output.message",
    contextType: null,
    contextId: null,
    payload: { content: "Okou Goal retired." },
  },
  {
    id: ids.slackPrompt,
    eventType: "input.prompt",
    contextType: "slack",
    contextId: SLACK_CONTEXT_ID,
    payload: {
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text: "from Slack" },
          { type: "source", kind: "slack" },
        ],
      },
    },
  },
  {
    id: ids.rejectedGoalPart,
    eventType: "input.rejected",
    contextType: "web",
    contextId: null,
    payload: {
      userMessage: {
        version: 1,
        parts: [{ type: "text", text: "Web goal part" }],
      },
    },
  },
];

function assertConverged(state: unknown): void {
  assert.ok(typeof state === "object" && state !== null);
  assert.deepEqual(Reflect.get(state, "events"), EXPECTED_EVENTS);
  assert.deepEqual(Reflect.get(state, "aggregate"), [
    {
      eventType: "control.revoke",
      contextType: "automation",
      contextIdIsNull: true,
      count: 1,
    },
    {
      eventType: "input.prompt",
      contextType: "automation",
      contextIdIsNull: true,
      count: 1,
    },
    {
      eventType: "input.prompt",
      contextType: "slack",
      contextIdIsNull: false,
      count: 1,
    },
    {
      eventType: "input.prompt",
      contextType: "web",
      contextIdIsNull: true,
      count: 1,
    },
    {
      eventType: "input.rejected",
      contextType: "automation",
      contextIdIsNull: true,
      count: 1,
    },
    {
      eventType: "input.rejected",
      contextType: "web",
      contextIdIsNull: true,
      count: 1,
    },
    {
      eventType: "output.message",
      contextType: null,
      contextIdIsNull: true,
      count: GOAL_OUTPUT_ROWS + 2,
    },
  ]);
  assert.deepEqual(Reflect.get(state, "runs"), [
    { id: ids.goalRun, triggerSource: "automation-schedule" },
    { id: ids.webRun, triggerSource: "web" },
  ]);
  assert.deepEqual(Reflect.get(state, "files"), [
    { externalId: "goal-file", source: "automation-schedule" },
    { externalId: "web-file", source: "web" },
  ]);
  assert.deepEqual(Reflect.get(state, "drafts"), [
    {
      document: {
        version: 1,
        parts: [
          { type: "text", text: "draft " },
          { type: "text", text: "Draft goal" },
        ],
      },
    },
    {
      document: {
        version: 1,
        parts: [{ type: "text", text: "Agent draft goal" }],
      },
    },
  ]);
  assert.deepEqual(Reflect.get(state, "shares"), [
    {
      messages: [
        { messageIndex: 0, role: "user", content: "hi" },
        { messageIndex: 1, role: "assistant", content: "hello", runIndex: 0 },
      ],
    },
  ]);
  assert.deepEqual(Reflect.get(state, "constraints"), [
    { name: "chat_events_context_pair_check", validated: true },
    { name: "chat_events_context_type_check", validated: true },
    { name: "chat_events_event_type_check", validated: true },
    { name: "chat_events_failure_reason_event_type_check", validated: true },
    { name: "chat_events_input_context_type_check", validated: true },
    { name: "chat_events_input_payload_content_check", validated: true },
    { name: "chat_events_input_user_message_payload_check", validated: true },
    {
      name: "chat_events_official_workflow_queue_claim_check",
      validated: true,
    },
  ]);
  assert.deepEqual(Reflect.get(state, "snapshotVersion"), [
    { validated: true, defaultVersion: "8" },
  ]);
  assert.deepEqual(Reflect.get(state, "helpers"), []);
}

async function withMigrationConnection(
  run: (sql: postgres.Sql) => Promise<void>,
): Promise<void> {
  const sql = postgres(fixtureUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    await run(sql);
  } finally {
    await sql.end();
  }
}

async function expectCheckViolation(
  client: Client,
  constraint: string,
  query: string,
): Promise<void> {
  await assert.rejects(client.query(query, [THREAD_ID]), (error: unknown) => {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23514" &&
      "constraint" in error &&
      error.constraint === constraint
    );
  });
}

const admin = new Client({ connectionString: adminUrl.toString() });
await admin.connect();
try {
  await admin.query(`CREATE DATABASE "${database}"`);
  await withMigrationConnection(async (sql) => {
    await applyPendingMigrations(sql, { beforeMillis: migrationMillis });
  });

  const client = new Client({ connectionString: fixtureUrl.toString() });
  await client.connect();
  try {
    await seedV7(client);

    // An interrupted first attempt: only the leading constraint swap ran.
    const migration = readMigrationFiles({
      migrationsFolder: new URL(`../${DRIZZLE_MIGRATE_OUT}`, import.meta.url)
        .pathname,
    }).find((candidate) => {
      return candidate.folderMillis === migrationMillis;
    });
    assert.ok(migration, `${MIGRATION_TAG} was not read`);
    const swapIndex = migration.sql.findIndex((statement) => {
      return statement.includes("ADD CONSTRAINT");
    });
    assert.ok(swapIndex > 0);
    await withMigrationConnection(async (sql) => {
      for (const statement of migration.sql.slice(0, swapIndex + 1)) {
        await sql.unsafe(statement);
      }
    });
    await expectCheckViolation(
      client,
      "chat_events_event_type_check",
      `INSERT INTO chat_events (chat_thread_id, event_type, seq_id)
       VALUES ($1, 'run.queued', 100000)`,
    );
    console.log("PASS interrupted attempt already holds new writes to V8");

    await withMigrationConnection(async (sql) => {
      await applyPendingMigrations(sql);
    });
    const converged = await readState(client);
    assertConverged(converged);

    // Every committed batch has its own transaction ID, so a single-transaction
    // rewrite would leave all Goal output rows with one xmin.
    const batches = await client.query<{ count: number }>(
      `SELECT count(DISTINCT xmin::text)::integer AS count
       FROM chat_events
       WHERE event_type = 'output.message' AND payload ->> 'content' LIKE 'goal output %'`,
    );
    assert.ok((batches.rows[0]?.count ?? 0) > 1);
    console.log("PASS V7 rows converge in committed batches");

    await expectCheckViolation(
      client,
      "chat_events_context_type_check",
      `INSERT INTO chat_events (chat_thread_id, event_type, context_type, seq_id)
       VALUES ($1, 'output.message', 'goal', 100001)`,
    );
    await expectCheckViolation(
      client,
      "chat_events_input_context_type_check",
      `INSERT INTO chat_events (chat_thread_id, event_type, payload, seq_id)
       VALUES ($1, 'input.prompt',
         '{"userMessage":{"version":1,"parts":[{"type":"text","text":"x"}]}}',
         100002)`,
    );
    await expectCheckViolation(
      client,
      "chat_events_input_context_type_check",
      `INSERT INTO chat_events (chat_thread_id, event_type, payload, seq_id)
       VALUES ($1, 'input.rejected',
         '{"userMessage":{"version":1,"parts":[{"type":"text","text":"x"}],"error":"x"}}',
         100003)`,
    );
    console.log("PASS V8 checks reject retired values");

    // A completed attempt run again converges to the same state.
    await client.query(
      `DELETE FROM drizzle.__drizzle_migrations WHERE created_at = $1`,
      [migrationMillis],
    );
    await withMigrationConnection(async (sql) => {
      await applyPendingMigrations(sql);
    });
    assert.deepEqual(await readState(client), converged);
    console.log("PASS re-running the completed migration is a no-op");
  } finally {
    await client.end();
  }
} finally {
  await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin.end();
}
