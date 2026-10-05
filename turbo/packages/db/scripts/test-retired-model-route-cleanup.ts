import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { z } from "zod";
import postgres from "postgres";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { DRIZZLE_MIGRATE_OUT } from "../drizzle.config";
import { applyPendingMigrations } from "./migration-runner";
import { validateModelCatalogSeed } from "./test-model-catalog-seed";

interface RouteRow {
  id: string;
  model: string;
  provider_type: string;
  concrete_provider_type: string;
  subscription_type: string | null;
  upstream_model: string;
  enabled: boolean;
  row: postgres.JSONValue;
}

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const databaseName = `route_cleanup_${randomUUID().replaceAll("-", "")}`;
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
  return item.tag.endsWith("_prune_retired_model_routes");
});
assert.ok(entry, "cleanup migration must remain in the journal until shipped");
const migration = readMigrationFiles({
  migrationsFolder: DRIZZLE_MIGRATE_OUT,
}).find((item) => {
  return item.folderMillis === entry.when;
});
assert.ok(migration, "cleanup migration is required");
assert.match(migration.sql.join("\n"), /Retired model route cleanup requires/);

await admin.query(`CREATE DATABASE "${databaseName}"`);
const sql = postgres(url.toString(), { max: 1 });
const throughCleanup = { beforeMillis: migration.folderMillis + 1 };
try {
  // Replay the actual preceding schema/data, including Custom contraction.
  await applyPendingMigrations(sql, { beforeMillis: migration.folderMillis });
  const fixtureModel = `subscription-${randomUUID()}`;
  await sql`
    INSERT INTO run_model_catalog (model, display_name, sort_order, lineage_rank)
    VALUES (${fixtureModel}, 'Future personal subscription', 10000, 100)
  `;
  // Disabled and future personal routes are metadata, not retirement targets.
  // The adjacent nullable marker is a former API-key route, not a subscription.
  await sql`
    INSERT INTO model_routes (
      model, provider_type, concrete_provider_type, subscription_type,
      upstream_model, enabled, service_tiers, efforts
    ) VALUES
      (${fixtureModel}, 'claude-code-oauth-token', 'claude-code-oauth-token',
       'claude-code-oauth-token', ${fixtureModel}, false, ARRAY[]::text[], ARRAY[]::text[]),
      (${fixtureModel}, 'claude-code-oauth-token', 'claude-code-oauth-token',
       NULL, ${fixtureModel}, true, ARRAY[]::text[], ARRAY[]::text[])
  `;

  // Keep real historical usage for a model whose execution routes are removed,
  // including a pending event, processed event and compacted hourly bucket.
  const fixtureOrg = `org-${randomUUID()}`;
  const fixtureUser = `user-${randomUUID()}`;
  await sql`
    INSERT INTO org_metadata (org_id, credits, tier)
    VALUES (${fixtureOrg}, 123, 'pro')
  `;
  await sql`
    INSERT INTO built_in_model_keys (vendor, api_key)
    VALUES ('openrouter', 'synthetic-test-key')
    ON CONFLICT (vendor) DO NOTHING
  `;
  await sql`
    INSERT INTO usage_event (
      idempotency_key, org_id, user_id, kind, provider, category, quantity,
      credits_charged, status, processed_at
    ) VALUES
      (${randomUUID()}, ${fixtureOrg}, ${fixtureUser}, 'model', 'gpt-5.6-sol',
       'tokens.input', 100, NULL, 'pending', NULL),
      (${randomUUID()}, ${fixtureOrg}, ${fixtureUser}, 'model', 'gpt-5.6-sol',
       'tokens.output', 20, 15, 'processed', '2026-10-01T10:00:00Z')
  `;
  await sql`
    INSERT INTO usage_event_hourly_rollup (
      processed_hour, org_id, user_id, kind, provider, category, quantity,
      credits_charged, allowance_units
    ) VALUES (
      '2026-10-01T09:00:00Z', ${fixtureOrg}, ${fixtureUser}, 'model',
      'gpt-5.6-sol', 'tokens.input', 200, 30, 0
    )
  `;

  async function routes() {
    const rows = await sql<RouteRow[]>`
      SELECT id, model, provider_type, concrete_provider_type, subscription_type,
             upstream_model, enabled, to_jsonb(model_routes) AS row
      FROM model_routes ORDER BY id
    `;
    return Array.from(rows);
  }
  const before = await routes();
  const keepIds = new Set(
    before
      .filter((row) => {
        if (
          row.provider_type === "claude-code-oauth-token" ||
          row.provider_type === "codex-oauth-token"
        ) {
          return row.subscription_type === row.provider_type;
        }
        return (
          row.provider_type === "built-in" &&
          row.concrete_provider_type === "openrouter-codex" &&
          row.subscription_type === null &&
          ((row.model === "okou-1.0" &&
            row.upstream_model === "@preset/okou-1-0") ||
            (row.model === "deepseek-v4.1-flash" &&
              row.upstream_model === "deepseek/deepseek-v4.1-flash"))
        );
      })
      .map((row) => {
        return row.id;
      }),
  );
  assert.ok(before.length > keepIds.size, "seeded obsolete routes exist");
  const retainedTables = [
    "run_model_catalog",
    "usage_pricing",
    "usage_event",
    "usage_event_hourly_rollup",
    "agent_runs",
    "built_in_model_keys",
    "model_providers",
    "model_provider_accounts",
    "model_provider_account_secrets",
    "org_metadata",
    "org_members_metadata",
    "chat_threads",
    "agents",
    "workflows",
    "workflow_automations",
  ];
  async function snapshot(table: string) {
    return await sql<{ row: unknown }[]>`
      SELECT to_jsonb(retained) AS row FROM ${sql(table)} AS retained
      ORDER BY to_jsonb(retained)::text
    `;
  }
  const unchanged = new Map<string, unknown>();
  for (const table of retainedTables) {
    unchanged.set(table, await snapshot(table));
  }
  const journalBefore = await sql`
    SELECT * FROM drizzle.__drizzle_migrations ORDER BY id
  `;

  async function assertRejected(message: RegExp, expected = before) {
    await assert.rejects(applyPendingMigrations(sql, throughCleanup), message);
    assert.deepEqual(
      await routes(),
      expected,
      "rejection preserves every route",
    );
    assert.deepEqual(
      await sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`,
      journalBefore,
      "rejected migration is not journaled",
    );
  }
  for (const table of [
    "org_model_policies",
    "model_provider_connections",
    "model_provider_surfaces",
  ]) {
    await sql`CREATE TABLE ${sql(table)} (id text PRIMARY KEY)`;
    await assertRejected(/requires Custom configuration retirement/);
    await sql`DROP TABLE ${sql(table)}`;
  }
  await sql`ALTER TABLE org_metadata ADD COLUMN model_mode text`;
  await assertRejected(/requires Custom configuration retirement/);
  await sql`ALTER TABLE org_metadata DROP COLUMN model_mode`;

  // Missing, disabled or drifted required bindings fail before any deletion.
  for (const model of ["okou-1.0", "deepseek-v4.1-flash"]) {
    const binding = before.find((row) => {
      return keepIds.has(row.id) && row.model === model;
    });
    assert.ok(binding, `${model}: required binding`);
    await sql`UPDATE model_routes SET enabled = false WHERE id = ${binding.id}`;
    const disabled = await routes();
    await assertRejected(
      /requires the active Auto and memory bindings/,
      disabled,
    );
    await sql`UPDATE model_routes SET enabled = true WHERE id = ${binding.id}`;
    await sql`UPDATE model_routes SET upstream_model = 'drifted' WHERE id = ${binding.id}`;
    const drifted = await routes();
    await assertRejected(
      /requires the active Auto and memory bindings/,
      drifted,
    );
    await sql`
      UPDATE model_routes SET upstream_model = ${binding.upstream_model}
      WHERE id = ${binding.id}
    `;
    await sql`DELETE FROM model_routes WHERE id = ${binding.id}`;
    await assertRejected(
      /requires the active Auto and memory bindings/,
      await routes(),
    );
    await sql`
      INSERT INTO model_routes
      SELECT (jsonb_populate_record(NULL::model_routes, ${sql.json(binding.row)})).*
    `;
  }
  await applyPendingMigrations(sql, throughCleanup);
  const after = await routes();
  assert.deepEqual(
    after,
    before.filter((row) => {
      return keepIds.has(row.id);
    }),
    "only retired routes are removed; every retained column is unchanged",
  );
  for (const table of retainedTables) {
    assert.deepEqual(await snapshot(table), unchanged.get(table), table);
  }
  await validateModelCatalogSeed(url.toString());
  const journalAfter = await sql`
    SELECT * FROM drizzle.__drizzle_migrations ORDER BY id
  `;
  assert.equal(journalAfter.length, journalBefore.length + 1);
  await applyPendingMigrations(sql, throughCleanup);
  assert.deepEqual(await routes(), after, "journaled retry is a no-op");
  assert.deepEqual(
    await sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`,
    journalAfter,
  );
  // Also prove the SQL cleanup itself is idempotent without the journal skip.
  await sql.begin(async (transaction) => {
    for (const statement of migration.sql) {
      await transaction.unsafe(statement);
    }
  });
  assert.deepEqual(await routes(), after, "SQL retry is a no-op");
  // A distinct data migration preserves launch defaults on the exact personal
  // routes; the destructive cleanup above still leaves retained columns intact.
  await applyPendingMigrations(sql);
  const defaults = await sql<
    { model: string; default_effort: string | null }[]
  >`
    SELECT model, default_effort FROM model_routes
    WHERE subscription_type = provider_type AND model <> ${fixtureModel}
    ORDER BY model
  `;
  assert.deepEqual(Array.from(defaults), [
    { model: "claude-fable-5-1", default_effort: "max" },
    { model: "claude-opus-5-5", default_effort: "medium" },
    { model: "claude-sonnet-5-5", default_effort: "high" },
    { model: "gpt-6-astra", default_effort: "max" },
    { model: "gpt-6-luna", default_effort: "xhigh" },
    { model: "gpt-6-sol", default_effort: "max" },
    { model: "gpt-6.1-sol", default_effort: "medium" },
  ]);
  const futureRoute = after.find((route) => route.model === fixtureModel);
  assert.ok(futureRoute);
  assert.deepEqual(
    (await routes()).find((route) => route.id === futureRoute.id),
    futureRoute,
  );
  const defaultEntry = journal.entries.find((item) =>
    item.tag.endsWith("_preserve_subscription_route_effort_defaults"),
  );
  assert.ok(defaultEntry);
  const defaultMigration = readMigrationFiles({
    migrationsFolder: DRIZZLE_MIGRATE_OUT,
  }).find((item) => item.folderMillis === defaultEntry.when);
  assert.ok(defaultMigration);
  const defaultsAfter = await routes();
  for (const statement of defaultMigration.sql) await sql.unsafe(statement);
  assert.deepEqual(
    await routes(),
    defaultsAfter,
    "default migration SQL retry is a no-op",
  );
  await sql`UPDATE model_routes SET enabled = false, default_effort = NULL WHERE model = 'claude-fable-5-1'`;
  await sql`UPDATE model_routes SET default_effort = 'low' WHERE model = 'claude-opus-5-5'`;
  const explicitlyConfigured = await routes();
  for (const statement of defaultMigration.sql) await sql.unsafe(statement);
  assert.deepEqual(
    await routes(),
    explicitlyConfigured,
    "disabled routes and explicit defaults are never rewritten",
  );
  for (const table of retainedTables)
    assert.deepEqual(await snapshot(table), unchanged.get(table), table);
  console.log(
    `Retired route cleanup passed: ${before.length - after.length} removed, ${after.length} retained; rollback guards, preservation and retries verified`,
  );
} finally {
  await sql.end();
  await admin.query(`DROP DATABASE "${databaseName}"`);
  await admin.end();
}
