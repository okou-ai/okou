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

interface PreferenceRow {
  user_id: string;
  selected_model: string | null;
  service_tier: string | null;
  model_settings: postgres.JSONValue;
  updated_at: Date;
}

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const databaseName = `auto_model_selection_${randomUUID().replaceAll("-", "")}`;
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
  return item.tag.endsWith("_auto_model_selection_null");
});
assert.ok(entry, "Auto selection migration must remain in the journal");
const migration = readMigrationFiles({
  migrationsFolder: DRIZZLE_MIGRATE_OUT,
}).find((item) => {
  return item.folderMillis === entry.when;
});
assert.ok(migration, "Auto selection migration is required");

await admin.query(`CREATE DATABASE "${databaseName}"`);
const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
try {
  await applyPendingMigrations(sql, { beforeMillis: migration.folderMillis });

  // The catalog facts the fixtures rely on.
  const catalog = await sql`
    SELECT
      catalog.model,
      catalog.replaced_by,
      EXISTS (
        SELECT 1 FROM model_routes AS route
        WHERE route.model = catalog.model
          AND route.enabled AND route.subscription_type IS NOT NULL
      ) AS subscription
    FROM run_model_catalog AS catalog
    WHERE catalog.model IN (
      'okou-1.0', 'okou-1.0-pro', 'deepseek-v4.1-flash', 'gpt-6-luna'
    )
    ORDER BY catalog.model
  `;
  assert.deepEqual(Array.from(catalog), [
    { model: "deepseek-v4.1-flash", replaced_by: null, subscription: false },
    { model: "gpt-6-luna", replaced_by: null, subscription: true },
    { model: "okou-1.0", replaced_by: null, subscription: false },
    { model: "okou-1.0-pro", replaced_by: "okou-1.0", subscription: false },
  ]);
  const [route] = await sql`
    SELECT count(DISTINCT model)::int AS count FROM model_routes
    WHERE upstream_model = 'deepseek/deepseek-v4.1-flash'
  `;
  assert.equal(route?.count, 1);

  const orgId = `org-${randomUUID()}`;
  const ownerId = `user-${randomUUID()}`;
  const peerId = `user-${randomUUID()}`;
  const agentId = randomUUID();
  await sql`
    INSERT INTO agents (id, org_id, owner, name)
    VALUES (${agentId}, ${orgId}, ${ownerId}, 'auto-model-selection')
  `;
  // The owner's stream already has five events; the peer's has none.
  await sql`
    INSERT INTO chat_thread_event_sequences (user_id, org_id, last_seq_id)
    VALUES (${ownerId}, ${orgId}, 5)
  `;

  const settings = { "gpt-6-luna": { effort: "high" } };
  const fixtures = [
    // Not selectable: active catalog models without an enabled subscription
    // route, by catalog id or by unique upstream id.
    {
      key: "okou",
      user: ownerId,
      agent: agentId,
      model: "okou-1.0",
      tier: "fast",
    },
    {
      key: "deepseek",
      user: ownerId,
      agent: agentId,
      model: "deepseek-v4.1-flash",
    },
    {
      key: "upstream",
      user: peerId,
      agent: agentId,
      model: "deepseek/deepseek-v4.1-flash",
    },
    { key: "agentless", user: ownerId, agent: null, model: "okou-1.0" },
    // Retired into the Auto run model.
    { key: "replaced", user: ownerId, agent: agentId, model: "okou-1.0-pro" },
    // Selectable or out of scope: kept.
    {
      key: "subscription",
      user: ownerId,
      agent: agentId,
      model: "gpt-6-luna",
      tier: "fast",
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

  const preferenceFixtures = [
    { key: "okou", model: "okou-1.0", tier: "priority" },
    { key: "deepseek", model: "deepseek-v4.1-flash", tier: null },
    { key: "subscription", model: "gpt-6-luna", tier: "priority" },
    { key: "auto", model: null, tier: null },
  ] as const;
  const preferenceUsers = new Map<string, string>();
  for (const fixture of preferenceFixtures) {
    const userId = `user-${randomUUID()}`;
    preferenceUsers.set(fixture.key, userId);
    await sql`
      INSERT INTO org_members_metadata (
        org_id, user_id, selected_model, service_tier, model_settings,
        updated_at
      ) VALUES (
        ${orgId}, ${userId}, ${fixture.model}, ${fixture.tier},
        ${sql.json(settings)}, '2026-01-01T00:00:00Z'
      )
    `;
  }
  function preferenceUser(key: string): string {
    const id = preferenceUsers.get(key);
    assert.ok(id, key);
    return id;
  }

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
  async function preferences(): Promise<Map<string, PreferenceRow>> {
    const rows = await sql<PreferenceRow[]>`
      SELECT user_id, selected_model, service_tier, model_settings, updated_at
      FROM org_members_metadata WHERE org_id = ${orgId}
    `;
    return new Map(
      rows.map((row) => {
        return [row.user_id, row];
      }),
    );
  }

  const before = await threads();
  const beforePreferences = await preferences();
  await applyPendingMigrations(sql, {
    beforeMillis: migration.folderMillis + 1,
  });
  const after = await threads();
  const afterPreferences = await preferences();

  for (const key of ["okou", "deepseek", "upstream", "agentless", "replaced"]) {
    const row = after.get(threadId(key));
    assert.ok(row, key);
    assert.equal(row.selected_model, null, `${key} returns to Auto`);
    assert.equal(row.codex_service_tier, null, `${key} has no tier`);
    assert.deepEqual(row.model_settings, settings, `${key} keeps settings`);
    assert.ok(
      row.updated_at > (before.get(threadId(key))?.updated_at ?? new Date()),
      `${key} is touched`,
    );
  }
  for (const key of ["subscription", "auto"]) {
    assert.deepEqual(
      after.get(threadId(key)),
      before.get(threadId(key)),
      `${key} is unchanged`,
    );
  }

  // One model event per cleared thread, plus the tier event where a tier was
  // cleared, in thread order after the stream's existing positions.
  const ownerCleared = [
    threadId("okou"),
    threadId("deepseek"),
    threadId("replaced"),
  ].sort();
  const expectedOwner = ownerCleared.flatMap((id) => {
    const model = {
      chat_thread_id: id,
      kind: "model_selection_updated",
      agent_id: agentId,
      selected_model: null,
      model_settings_patch: null,
      service_tier: null,
    };
    return id === threadId("okou")
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
      chat_thread_id: threadId("upstream"),
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

  for (const key of ["okou", "deepseek"]) {
    const row = afterPreferences.get(preferenceUser(key));
    assert.ok(row, key);
    assert.equal(row.selected_model, null, `${key} preference returns to Auto`);
    assert.equal(row.service_tier, null, `${key} preference has no tier`);
    assert.deepEqual(row.model_settings, settings, `${key} keeps settings`);
    assert.ok(
      row.updated_at >
        (beforePreferences.get(preferenceUser(key))?.updated_at ?? new Date()),
      `${key} preference is touched`,
    );
  }
  for (const key of ["subscription", "auto"]) {
    assert.deepEqual(
      afterPreferences.get(preferenceUser(key)),
      beforePreferences.get(preferenceUser(key)),
      `${key} preference is unchanged`,
    );
  }

  // A rerun finds nothing left to clear.
  const afterOwnerEvents = await events(ownerId);
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0372; new non-billing transactions are prohibited.
  await sql.begin(async (tx) => {
    for (const statement of migration.sql) await tx.unsafe(statement);
  });
  assert.deepEqual(await threads(), after);
  assert.deepEqual(await events(ownerId), afterOwnerEvents);
  assert.deepEqual(await preferences(), afterPreferences);

  console.log(
    "Auto model selection cleanup passed: unselectable thread and member selections are NULL with ordered thread events; subscription and Auto selections retained",
  );
} finally {
  await sql.end();
  await admin.query(`DROP DATABASE "${databaseName}"`);
  await admin.end();
}
