import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { z } from "zod";
import postgres from "postgres";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { DRIZZLE_MIGRATE_OUT } from "../drizzle.config";
import { applyPendingMigrations } from "./migration-runner";

interface ThreadRow {
  id: string;
  selected_model: string | null;
  codex_service_tier: string | null;
  model_settings: postgres.JSONValue;
  updated_at: Date;
}

interface EventRow {
  seq_id: string;
  chat_thread_id: string;
  kind: string;
  agent_id: string | null;
  selected_model: string | null;
  model_settings_patch: postgres.JSONValue;
  service_tier: string | null;
}

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const databaseName = `thread_model_cleanup_${randomUUID().replaceAll("-", "")}`;
const admin = new Client({ connectionString: databaseUrl });
await admin.connect();
const url = new URL(databaseUrl);
url.pathname = `/${databaseName}`;
const journal = z
  .object({
    entries: z.array(z.object({ tag: z.string(), when: z.number() })),
  })
  .parse(
    JSON.parse(
      await readFile(`${DRIZZLE_MIGRATE_OUT}/meta/_journal.json`, "utf8"),
    ),
  );
const entry = journal.entries.find((item) => {
  return item.tag.endsWith(
    "_clear_unselectable_thread_models_and_unused_model_keys",
  );
});
assert.ok(entry, "cleanup migration must remain in the journal until shipped");
const migration = readMigrationFiles({
  migrationsFolder: DRIZZLE_MIGRATE_OUT,
}).find((item) => {
  return item.folderMillis === entry.when;
});
assert.ok(migration, "cleanup migration is required");

await admin.query(`CREATE DATABASE "${databaseName}"`);
const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
try {
  await applyPendingMigrations(sql, { beforeMillis: migration.folderMillis });

  const vendors = [
    "openrouter",
    "zai",
    "anthropic",
    "openai",
    "deepseek",
    "minimax",
    "moonshot",
  ];
  for (const vendor of vendors) {
    await sql`
      INSERT INTO built_in_model_keys (vendor, api_key)
      VALUES (${vendor}, ${`synthetic-${vendor}-key`})
      ON CONFLICT (vendor) DO NOTHING
    `;
  }
  const [openRouterKey] = await sql`
    SELECT to_jsonb(built_in_model_keys) AS row
    FROM built_in_model_keys WHERE vendor = 'openrouter'
  `;
  assert.ok(openRouterKey);

  const orgId = `org-${randomUUID()}`;
  const ownerId = `user-${randomUUID()}`;
  const peerId = `user-${randomUUID()}`;
  const agentId = randomUUID();
  await sql`
    INSERT INTO agents (id, org_id, owner, name)
    VALUES (${agentId}, ${orgId}, ${ownerId}, 'thread-model-cleanup')
  `;
  // The owner's stream already has five events; the peer's has none.
  await sql`
    INSERT INTO chat_thread_event_sequences (user_id, org_id, last_seq_id)
    VALUES (${ownerId}, ${orgId}, 5)
  `;

  const settings = { "claude-sonnet-4.6": { effort: "high" } };
  const fixtures = [
    // Not resolvable: neither a catalog model nor a route's upstream id.
    {
      key: "tiered",
      user: ownerId,
      agent: agentId,
      model: "claude-sonnet-4.6",
      tier: "fast",
    },
    { key: "unknown", user: ownerId, agent: agentId, model: "vm0-model" },
    { key: "peer", user: peerId, agent: agentId, model: "kimi-k2.5" },
    { key: "agentless", user: ownerId, agent: null, model: "codex" },
    // Resolvable selections stay.
    { key: "active", user: ownerId, agent: agentId, model: "gpt-6-luna" },
    {
      key: "replaced",
      user: ownerId,
      agent: agentId,
      model: "claude-sonnet-4-6",
      tier: "fast",
    },
    {
      key: "upstream",
      user: ownerId,
      agent: agentId,
      model: "deepseek/deepseek-v4.1-flash",
    },
    { key: "auto", user: ownerId, agent: agentId, model: null },
  ] as const;
  const threadIds = new Map<string, string>();
  for (const fixture of fixtures) {
    const id = randomUUID();
    threadIds.set(fixture.key, id);
    await sql`
      INSERT INTO chat_threads (
        id, user_id, agent_id, selected_model, codex_service_tier,
        model_settings, updated_at
      ) VALUES (
        ${id}, ${fixture.user}, ${fixture.agent}, ${fixture.model},
        ${"tier" in fixture ? fixture.tier : null}, ${sql.json(settings)},
        '2026-01-01T00:00:00Z'
      )
    `;
  }
  function threadId(key: string): string {
    const id = threadIds.get(key);
    assert.ok(id, key);
    return id;
  }

  const [catalog] = await sql`
    SELECT
      count(*) FILTER (WHERE model = 'gpt-6-luna')::int AS active,
      count(*) FILTER (WHERE model = 'claude-sonnet-4-6')::int AS replaced
    FROM run_model_catalog
  `;
  assert.deepEqual(catalog, { active: 1, replaced: 1 });
  const [route] = await sql`
    SELECT count(*)::int AS count FROM model_routes
    WHERE upstream_model = 'deepseek/deepseek-v4.1-flash'
  `;
  assert.equal(route?.count, 1);

  async function threads(): Promise<Map<string, ThreadRow>> {
    const rows = await sql<ThreadRow[]>`
      SELECT id, selected_model, codex_service_tier, model_settings, updated_at
      FROM chat_threads WHERE agent_id = ${agentId} OR agent_id IS NULL
    `;
    return new Map(
      rows.map((row) => {
        return [row.id, row];
      }),
    );
  }
  async function events(userId: string): Promise<EventRow[]> {
    return Array.from(
      await sql<EventRow[]>`
        SELECT seq_id::text, chat_thread_id, kind::text, agent_id,
               selected_model, model_settings_patch, service_tier
        FROM chat_thread_events
        WHERE user_id = ${userId} AND org_id = ${orgId}
        ORDER BY seq_id
      `,
    );
  }

  const before = await threads();
  await applyPendingMigrations(sql, {
    beforeMillis: migration.folderMillis + 1,
  });
  const after = await threads();

  for (const key of ["tiered", "unknown", "peer", "agentless"]) {
    const row = after.get(threadId(key));
    assert.ok(row, key);
    assert.equal(row.selected_model, null, `${key} returns to Auto`);
    assert.equal(row.codex_service_tier, null, `${key} clears its tier`);
    assert.deepEqual(row.model_settings, settings, `${key} keeps settings`);
    assert.ok(
      row.updated_at > (before.get(threadId(key))?.updated_at ?? new Date()),
      `${key} is touched`,
    );
  }
  for (const key of ["active", "replaced", "upstream", "auto"]) {
    assert.deepEqual(
      after.get(threadId(key)),
      before.get(threadId(key)),
      `${key} is unchanged`,
    );
  }

  // One model event per cleared thread, plus the tier event where a tier was
  // cleared, in thread order after the stream's existing positions.
  const ownerCleared = [threadId("tiered"), threadId("unknown")].sort();
  const expectedOwner = ownerCleared.flatMap((id) => {
    const model = {
      chat_thread_id: id,
      kind: "model_selection_updated",
      agent_id: agentId,
      selected_model: null,
      model_settings_patch: null,
      service_tier: null,
    };
    return id === threadId("tiered")
      ? [model, { ...model, kind: "service_tier_updated" }]
      : [model];
  });
  assert.deepEqual(
    await events(ownerId),
    expectedOwner.map((event, index) => {
      return { seq_id: String(6 + index), ...event };
    }),
  );
  assert.deepEqual(await events(peerId), [
    {
      seq_id: "1",
      chat_thread_id: threadId("peer"),
      kind: "model_selection_updated",
      agent_id: agentId,
      selected_model: null,
      model_settings_patch: null,
      service_tier: null,
    },
  ]);
  const sequences = await sql`
    SELECT user_id, last_seq_id::int AS last FROM chat_thread_event_sequences
    WHERE org_id = ${orgId} ORDER BY last_seq_id
  `;
  assert.deepEqual(Array.from(sequences), [
    { user_id: peerId, last: 1 },
    { user_id: ownerId, last: 5 + expectedOwner.length },
  ]);
  const [agentless] = await sql`
    SELECT count(*)::int AS count FROM chat_thread_events
    WHERE chat_thread_id = ${threadId("agentless")}
  `;
  assert.equal(agentless?.count, 0, "agentless threads have no event stream");

  const keys = await sql`
    SELECT to_jsonb(built_in_model_keys) AS row FROM built_in_model_keys
  `;
  assert.deepEqual(
    Array.from(keys),
    [openRouterKey],
    "only the OpenRouter key remains, unchanged",
  );

  // A rerun finds nothing left to clear.
  const afterThreads = await threads();
  const afterOwnerEvents = await events(ownerId);
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0432; new non-billing transactions are prohibited.
  await sql.begin(async (tx) => {
    for (const statement of migration.sql) await tx.unsafe(statement);
  });
  assert.deepEqual(await threads(), afterThreads);
  assert.deepEqual(await events(ownerId), afterOwnerEvents);

  console.log(
    "Unselectable thread model cleanup passed: snapshots cleared with ordered events; resolvable selections and the OpenRouter key retained",
  );
} finally {
  await sql.end();
  await admin.query(`DROP DATABASE "${databaseName}"`);
  await admin.end();
}
