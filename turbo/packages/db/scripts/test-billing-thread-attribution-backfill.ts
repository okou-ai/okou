import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import postgres from "postgres";
import { z } from "zod";
import { applyFixtureMigrations } from "./fixtures/migrate-with-empty-instructions";

// The production caller is the migration runner. These historical ledger shapes
// predate the current API writers and are tested at that native SQL boundary.
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
  return entry.tag.endsWith("_backfill_billing_thread_attribution");
});
assert.ok(target, "Billing Thread backfill must exist");
const databaseName = `billing_thread_${randomUUID().replaceAll("-", "")}`;
const admin = new Client({ connectionString: databaseUrl });
await admin.connect();
const ownedUrl = new URL(databaseUrl);
ownedUrl.pathname = `/${databaseName}`;
await admin.query(`CREATE DATABASE "${databaseName}"`);
const sql = postgres(ownedUrl.toString(), { max: 1, onnotice: () => {} });
const client = new Client({ connectionString: ownedUrl.toString() });
const anchor = "2026-08-01 12:34:56.123456";
const captured = "2026-08-02 00:00:00.654321";
const thread = uuid(9000);
const secondThread = uuid(9001);
const outsideThread = uuid(9002);
const unavailableThread = uuid(9003);
const ledgers = ["usage_event", "usage_event_hourly_rollup"] as const;
type Ledger = (typeof ledgers)[number];

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}

async function run(
  id: number,
  options: {
    threadId?: string | null;
    owner?: string;
    source?: string | null;
  } = {},
) {
  await client.query(
    `INSERT INTO agent_runs
    (id, org_id, user_id, status, prompt, trigger_source, autonomy_budget, chat_thread_id, created_at, started_at)
    VALUES ($1, 'billing-org', $2, 'completed', 'Historical input', $3::varchar, CASE WHEN $3::varchar IS NULL THEN NULL ELSE 32 END, $4, $5, '2026-08-01 13:00:00')`,
    [
      uuid(id),
      options.owner ?? "billing-user",
      options.source === undefined ? "web" : options.source,
      options.threadId === undefined ? thread : options.threadId,
      anchor,
    ],
  );
}

async function attribution(
  id: number,
  options: {
    owner?: string;
    source?: string;
    anchorAt?: string;
    threadId?: string | null;
    context?: string;
    observed?: boolean;
  } = {},
) {
  await client.query(
    `INSERT INTO billing_run_attribution
    (run_id, org_id, user_id, run_started_at, source, thread_id, thread_context, usage_observed, captured_at)
    VALUES ($1, 'billing-org', $2, $3, $4, $5, $6, $7, $8)`,
    [
      uuid(id),
      options.owner ?? "billing-user",
      options.anchorAt ?? anchor,
      options.source ?? "chat",
      options.threadId ?? null,
      options.context ?? "unknown",
      options.observed ?? false,
      captured,
    ],
  );
}

async function usage(
  ledger: Ledger,
  id: number,
  runId: number | null,
  options: {
    billingId?: number | null;
    anchorAt?: string | null;
    context?: string;
    owner?: string;
    pending?: boolean;
    credits?: number;
  } = {},
) {
  const raw = ledger === "usage_event";
  await client.query(
    `INSERT INTO ${ledger}
    (id, org_id, user_id, run_id, billing_run_id, billing_anchor_at, billing_context,
     kind, provider, category, quantity, credits_charged,
     ${raw ? "idempotency_key, pricing_unit_price, pricing_unit_size, pricing_credits_limit, status, created_at, processed_at" : "processed_hour"})
    VALUES ($1, 'billing-org', $2, $3, $4, $5, $6, 'model', 'historical-provider', 'tokens.input', 2323, $7,
      ${raw ? "gen_random_uuid(), 17, 1000, 20000, $8, '2026-08-01 22:00:00', $9" : "'2026-08-02 00:00:00'"})`,
    [
      uuid(id),
      options.owner ?? "billing-user",
      runId === null ? null : uuid(runId),
      options.billingId === undefined || options.billingId === null
        ? null
        : uuid(options.billingId),
      options.anchorAt ?? null,
      options.context ?? "legacy_unknown",
      options.credits ?? 7,
      ...(raw
        ? [
            options.pending ? "pending" : "processed",
            options.pending ? null : "2026-08-02 00:45:00",
          ]
        : []),
    ],
  );
}

async function state(query: string): Promise<string[]> {
  const result = await client.query<{ fact: unknown }>(query);
  return z
    .array(z.object({ fact: z.string() }))
    .parse(result.rows)
    .map((row) => {
      return row.fact;
    });
}

async function financialState() {
  return state(`SELECT (to_jsonb(u) - ARRAY['billing_run_id', 'billing_anchor_at', 'billing_context'])::text AS fact
    FROM usage_event u
    UNION ALL
    SELECT (to_jsonb(h) - ARRAY['billing_run_id', 'billing_anchor_at', 'billing_context'])::text
    FROM usage_event_hourly_rollup h ORDER BY fact`);
}

async function allState() {
  return state(`SELECT to_jsonb(a)::text AS fact FROM billing_run_attribution a
    UNION ALL SELECT to_jsonb(u)::text FROM usage_event u
    UNION ALL SELECT to_jsonb(h)::text FROM usage_event_hourly_rollup h ORDER BY fact`);
}

try {
  await applyFixtureMigrations(sql, { beforeMillis: target.when });
  await client.connect();
  await client.query(
    `INSERT INTO agents (id, org_id, owner, name)
    VALUES ($1, 'billing-org', 'billing-user', 'Historical billing')`,
    [uuid(8999)],
  );
  await client.query(
    `INSERT INTO chat_threads (id, user_id, agent_id) VALUES
    ($1, 'billing-user', $4), ($2, 'billing-user', $4), ($3, 'outside-user', $4)`,
    [thread, secondThread, outsideThread, uuid(8999)],
  );
  // The first full batch has no recoverable evidence. Cursor advancement must
  // still reach later rows. It must not retain provisional Runs as bill facts.
  await client.query(`INSERT INTO agent_runs
    (id, org_id, user_id, status, prompt, trigger_source, autonomy_budget)
    SELECT ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
      'billing-org', 'billing-user', 'completed', 'No usage', 'web', 32
    FROM generate_series(1, 1001) n`);
  for (const ledger of ledgers) {
    await client.query(`INSERT INTO ${ledger}
      (id, org_id, user_id, kind, provider, category, quantity, credits_charged,
        ${ledger === "usage_event" ? "idempotency_key, status, processed_at" : "processed_hour"})
      SELECT ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
        'billing-org', 'billing-user', 'model', 'unresolved-provider', 'tokens.input', 100, 9,
        ${ledger === "usage_event" ? "gen_random_uuid(), 'processed', '2026-08-02'::timestamp" : "'2026-08-02'::timestamp"}
      FROM generate_series(1, 1001) n`);
  }
  // Create, fill, null-Thread identity, preserved captured/deleted Thread,
  // explicit threadless, unavailable Run with independent facts, and observed
  // repair on already canonical usage.
  for (const id of [10010, 10011, 10012, 10013, 10019]) await run(id);
  for (const id of [10014, 10015, 10016]) await run(id, { threadId: null });
  await attribution(10013);
  await attribution(10015, { threadId: unavailableThread, context: "thread" });
  await attribution(10016, { context: "threadless" });
  await attribution(10018);
  await attribution(10019, { threadId: thread, context: "thread" });
  for (const ledger of ledgers) {
    for (const id of [10010, 10011, 10012, 10014, 10015, 10016])
      await usage(ledger, id, id, { credits: id === 10010 ? 0 : 7 });
    await usage(ledger, 10013, 10013, {
      billingId: 10013,
      anchorAt: anchor,
      context: "run",
    });
    await usage(ledger, 10017, null, {
      billingId: 10017,
      context: "missing_run",
    });
    await usage(ledger, 10018, null, {
      billingId: 10018,
      context: "missing_run",
    });
    await usage(ledger, 10019, 10019, {
      billingId: 10019,
      anchorAt: anchor,
      context: "run",
    });
    await usage(ledger, 10020, null, { context: "runless", anchorAt: anchor });
    await usage(ledger, 10021, null, {
      context: "pi_memory_stage1",
      anchorAt: "2026-08-01 22:00:00",
    });
    // Multiple fragments of one Run cross batch boundaries; no duplicate
    // upsert target, repeated observation, or skipped tail is allowed.
    await client.query(
      `INSERT INTO ${ledger}
      SELECT (jsonb_populate_record(NULL::${ledger}, to_jsonb(u) ||
        jsonb_build_object('id', ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0')),
          ${ledger === "usage_event" ? "'idempotency_key', gen_random_uuid()" : "'category', 'tokens.output'"}))).*
      FROM ${ledger} u CROSS JOIN generate_series(20000, 21004) n WHERE u.id = $1`,
      [uuid(10012)],
    );
  }
  await run(10022);
  await usage("usage_event", 10022, 10022, { pending: true });
  await run(10023);
  await usage("usage_event", 10023, 10023, {
    billingId: 10023,
    context: "missing_run",
  });
  // Stable billing identity remains usable without the nullable content link.
  // Exercise each ledger independently so either evidence probe can capture it.
  for (const [ledger, id] of [
    ["usage_event", 10024],
    ["usage_event_hourly_rollup", 10025],
  ] as const) {
    await run(id);
    await usage(ledger, id, null, {
      billingId: id,
      anchorAt: anchor,
      context: "run",
    });
  }
  // A stable billing identity cannot override a conflicting retained Run link.
  await run(10026);
  await run(10027);
  for (const ledger of ledgers) {
    await usage(ledger, 10112, 10027, {
      billingId: 10026,
      anchorAt: anchor,
      context: "run",
    });
  }

  const conflicts = [
    10100, 10101, 10102, 10103, 10104, 10105, 10106, 10107, 10108, 10109,
  ];
  for (const id of conflicts) {
    await run(id, {
      owner: id === 10100 ? "outside-user" : "billing-user",
      threadId: id === 10106 ? outsideThread : id === 10107 ? null : thread,
    });
    if ([10101, 10102, 10104, 10105, 10107, 10109].includes(id)) {
      await attribution(id, {
        owner: id === 10101 ? "outside-user" : "billing-user",
        anchorAt: id === 10102 ? "2026-08-01 12:34:56.123455" : anchor,
        source: id === 10104 ? "automation" : "chat",
        threadId:
          id === 10105 ? secondThread : id === 10107 ? outsideThread : null,
        context: [10105, 10107].includes(id)
          ? "thread"
          : id === 10109
            ? "threadless"
            : "unknown",
      });
    }
    for (const ledger of ledgers) {
      await usage(ledger, id, id, {
        billingId: id === 10108 ? 10010 : id === 10103 ? id : null,
        context:
          id === 10103
            ? "run"
            : id === 10108
              ? "missing_run"
              : "legacy_unknown",
        anchorAt: id === 10103 ? "2026-08-01 12:34:56.123455" : null,
      });
    }
  }
  await run(10110);
  await run(10111);
  await attribution(10111);
  await client.query(
    "UPDATE agent_runs SET org_id = 'outside-org' WHERE id = $1",
    [uuid(10110)],
  );
  await client.query(
    "UPDATE billing_run_attribution SET org_id = 'outside-org' WHERE run_id = $1",
    [uuid(10111)],
  );
  for (const ledger of ledgers) {
    await usage(ledger, 10110, 10110);
    await usage(ledger, 10111, 10111);
  }
  // Exercise the exact current source mapping, including both automation
  // triggers and future/absent source values that canonically map to other.
  const sources = [
    "web",
    "automation-schedule",
    "automation-event",
    "slack",
    "discord",
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
    await run(10200 + index, {
      source,
      threadId: source === null ? null : thread,
    });
    await usage("usage_event_hourly_rollup", 10200 + index, 10200 + index);
  }
  const financialBefore = await financialState();
  const immutableBefore = await state(
    `SELECT (to_jsonb(a) - ARRAY['thread_id', 'thread_context', 'usage_observed'])::text AS fact FROM billing_run_attribution a ORDER BY run_id`,
  );
  const conflictPredicate =
    "'00000000-0000-4000-8000-000000010100'::uuid AND '00000000-0000-4000-8000-000000010112'::uuid";
  const conflictQuery = `SELECT to_jsonb(a)::text AS fact FROM billing_run_attribution a WHERE run_id BETWEEN ${conflictPredicate}
    UNION ALL SELECT to_jsonb(u)::text FROM usage_event u WHERE id BETWEEN ${conflictPredicate}
    UNION ALL SELECT to_jsonb(h)::text FROM usage_event_hourly_rollup h WHERE id BETWEEN ${conflictPredicate} ORDER BY fact`;
  const conflictsBefore = await state(conflictQuery);
  await applyFixtureMigrations(sql, { beforeMillis: target.when + 1 });
  assert.deepEqual(
    await financialState(),
    financialBefore,
    "Only billing metadata may change",
  );
  assert.deepEqual(
    await state(conflictQuery),
    conflictsBefore,
    "Conflicting facts must remain untouched",
  );
  assert.deepEqual(
    await state(
      `SELECT (to_jsonb(a) - ARRAY['thread_id', 'thread_context', 'usage_observed'])::text AS fact FROM billing_run_attribution a WHERE captured_at = '${captured}' ORDER BY run_id`,
    ),
    immutableBefore,
  );
  const rows = await client.query<{
    run_id: string;
    thread_id: string | null;
    thread_context: string;
    usage_observed: boolean;
    anchor: string;
  }>(
    `
    SELECT run_id, thread_id, thread_context, usage_observed, run_started_at::text AS anchor
    FROM billing_run_attribution WHERE run_id < $1 ORDER BY run_id`,
    [uuid(10100)],
  );
  assert.deepEqual(
    rows.rows,
    [
      10010, 10011, 10012, 10013, 10014, 10015, 10016, 10018, 10019, 10022,
      10023, 10024, 10025,
    ].map((id) => {
      return {
        run_id: uuid(id),
        thread_id: [10014, 10016, 10018].includes(id)
          ? null
          : id === 10015
            ? unavailableThread
            : thread,
        thread_context: [10014, 10018].includes(id)
          ? "unknown"
          : id === 10016
            ? "threadless"
            : "thread",
        usage_observed: true,
        anchor,
      };
    }),
  );
  for (const ledger of ledgers) {
    const gaps = await client.query(
      `SELECT id FROM ${ledger}
      WHERE id >= $1 AND id < $2 AND billing_context <> 'run' ORDER BY id`,
      [uuid(10010), uuid(10100)],
    );
    assert.deepEqual(
      gaps.rows,
      [10017, 10020, 10021].map((id) => {
        return { id: uuid(id) };
      }),
    );
    assert.deepEqual(
      (
        await client.query(`SELECT DISTINCT billing_anchor_at::text AS anchor FROM ${ledger}
      WHERE billing_context = 'run' AND id <> '00000000-0000-4000-8000-000000010103'::uuid`)
      ).rows,
      [{ anchor }],
    );
  }
  assert.deepEqual(
    (
      await client.query(
        `SELECT source FROM billing_run_attribution WHERE run_id >= $1 ORDER BY run_id`,
        [uuid(10200)],
      )
    ).rows,
    sources.map((source) => {
      return {
        source:
          source === "web"
            ? "chat"
            : source?.startsWith("automation-")
              ? "automation"
              : source === "future-source" || source === null
                ? "other"
                : source,
      };
    }),
  );
  // Removing the journal receipt replays the real batched SQL, rather than
  // merely testing the runner's already-applied shortcut.
  const firstPass = await allState();
  await client.query(
    "DELETE FROM drizzle.__drizzle_migrations WHERE created_at = $1",
    [target.when],
  );
  await applyFixtureMigrations(sql, { beforeMillis: target.when + 1 });
  assert.deepEqual(
    await allState(),
    firstPass,
    "Replaying the migration must be idempotent",
  );
  // Neither Run deletion nor Thread erasure may delete independent billing
  // facts. A captured ID grants no access to an unavailable Thread.
  await client.query("DELETE FROM agent_runs WHERE id = $1", [uuid(10010)]);
  await client.query("DELETE FROM chat_threads WHERE id = $1", [thread]);
  for (const ledger of ledgers) {
    assert.deepEqual(
      (
        await client.query(
          `SELECT run_id, billing_run_id, billing_anchor_at::text AS anchor, billing_context FROM ${ledger} WHERE id = $1`,
          [uuid(10010)],
        )
      ).rows,
      [
        {
          run_id: null,
          billing_run_id: uuid(10010),
          anchor,
          billing_context: "run",
        },
      ],
    );
  }
  assert.deepEqual(
    (
      await client.query(
        `SELECT a.thread_id, t.id FROM billing_run_attribution a
    LEFT JOIN chat_threads t ON t.id = a.thread_id WHERE a.run_id = $1`,
        [uuid(10010)],
      )
    ).rows,
    [{ thread_id: thread, id: null }],
  );
  console.log(
    "Billing Thread backfill: historical transitions, conflict isolation, batches, exact anchors, replay and deletion passed",
  );
} finally {
  await client.end();
  await sql.end();
  await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await admin.end();
}
