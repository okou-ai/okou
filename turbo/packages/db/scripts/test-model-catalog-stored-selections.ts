import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Client } from "pg";
import { z } from "zod";

const MIGRATION_FILE =
  "../src/migrations/1297_model_catalog_stored_selections.sql";

/**
 * Migration 1297_model_catalog_stored_selections: retired selections move
 * along the replacement chain, duplicate policies merge, cross-provider
 * policies are dropped instead of transplanted, efforts convert, history stays
 * and a second run is a no-op. Runs on transaction-owned copies of the real
 * tables and rolls back.
 */
export async function validateModelCatalogStoredSelections(
  databaseUrl: string,
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const schema = `model_selection_${randomUUID().replaceAll("-", "")}`;
  const tables = [
    "run_model_catalog",
    "model_routes",
    "org_model_policies",
    "org_members_metadata",
    "agents",
    "model_providers",
    "agent_runs",
    "usage_event",
  ] as const;
  type Table = (typeof tables)[number];
  const rowsSchema = z.array(z.record(z.string(), z.unknown()));

  async function rows(table: Table, orderBy: string) {
    const result = await client.query(
      `SELECT * FROM ${table} ORDER BY ${orderBy}`,
    );
    return rowsSchema.parse(result.rows);
  }

  async function snapshot() {
    const result: unknown[] = [];
    for (const table of tables) {
      const records = await client.query(
        `SELECT to_jsonb(record)::text AS value FROM ${table} AS record ORDER BY to_jsonb(record)::text`,
      );
      result.push(rowsSchema.parse(records.rows));
    }
    return result;
  }

  // The runner applies each migration in its own transaction, which drops the
  // ON COMMIT DROP work tables. This test keeps one outer transaction.
  async function applyMigration(migration: string) {
    await client.query(migration);
    await client.query(
      `DROP TABLE pg_temp.model_selection_rewrite,
         pg_temp.model_selection_rewrite_effort,
         pg_temp.model_selection_rewrite_policy`,
    );
  }

  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    await client.query("SET LOCAL lock_timeout = '1s'");
    await client.query("SET LOCAL statement_timeout = '10s'");
    for (const table of tables) {
      await client.query(
        `CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`,
      );
    }

    // Two-hop chain claude-opus-4-8 -> claude-opus-5 -> claude-opus-5-5 and two
    // retired models sharing gpt-6-luna.
    await client.query(`
      INSERT INTO run_model_catalog (
        model, display_name, sort_order, lineage_rank, replaced_by,
        replaced_by_lineage_rank
      ) VALUES
        ('claude-opus-5-5', 'Claude Opus 5.5', 1, 100, NULL, NULL),
        ('claude-opus-5', 'Claude Opus 5', 2, 50, 'claude-opus-5-5', 100),
        ('claude-opus-4-8', 'Claude Opus 4.8', 3, 0, 'claude-opus-5', 50),
        ('gpt-6-luna', 'GPT 6 Luna', 4, 100, NULL, NULL),
        ('deepseek-v4-pro', 'DeepSeek V4 Pro', 5, 0, 'gpt-6-luna', 100),
        ('gpt-5.5', 'GPT 5.5', 6, 0, 'gpt-6-luna', 100);
      INSERT INTO model_routes (
        model, provider_type, concrete_provider_type, upstream_model,
        service_tiers, efforts, default_effort, price_tier, pricing_kind,
        pricing_provider
      ) VALUES
        ('claude-opus-5-5', 'built-in', 'anthropic-api-key', 'claude-opus-5-5',
          ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'extra', 'max'],
          'medium', '$$$', 'model', 'claude-opus-5-5'),
        ('claude-opus-5-5', 'claude-code-oauth-token', 'claude-code-oauth-token',
          'claude-opus-5-5', ARRAY[]::text[], ARRAY['low', 'high'], 'high',
          NULL, NULL, NULL),
        ('gpt-6-luna', 'built-in', 'openai-api-key', 'gpt-6-luna',
          ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'xhigh', 'max'],
          'max', '$', 'model', 'gpt-6-luna'),
        ('gpt-6-luna', 'openai-api-key', 'openai-api-key', 'gpt-6-luna',
          ARRAY[]::text[], ARRAY['low', 'medium', 'high', 'xhigh', 'max'],
          'max', NULL, NULL, NULL);
      INSERT INTO org_model_policies (
        org_id, model, is_default, default_provider_type, credential_scope
      ) VALUES
        -- Two hops, renamed in place with its member subscription route.
        ('org-a', 'claude-opus-4-8', false, 'claude-code-oauth-token', 'member'),
        ('org-a', 'deepseek-v4-pro', true, 'built-in', 'org'),
        -- DeepSeek BYOK has no gpt-6-luna route: dropped, not transplanted.
        ('org-b', 'deepseek-v4-pro', true, 'deepseek', 'org'),
        ('org-b', 'gpt-5.5', false, 'built-in', 'org'),
        -- The existing replacement wins and takes the legacy default.
        ('org-c', 'deepseek-v4-pro', true, 'built-in', 'org'),
        ('org-c', 'gpt-5.5', false, 'built-in', 'org'),
        ('org-c', 'gpt-6-luna', false, 'built-in', 'org'),
        -- Two retired sources, no replacement: the default survives.
        ('org-d', 'deepseek-v4-pro', false, 'built-in', 'org'),
        ('org-d', 'gpt-5.5', true, 'built-in', 'org');
      INSERT INTO org_members_metadata (
        org_id, user_id, selected_model, model_settings
      ) VALUES
        ('org-a', 'user-a', 'claude-opus-4-8',
          '{"claude-opus-4-8":{"effort":"extra"}}'),
        ('org-b', 'user-b', 'deepseek-v4-pro',
          '{"deepseek-v4-pro":{"effort":"ultra"},"gpt-5.5":{"effort":"low"}}'),
        ('org-c', 'user-c', 'gpt-6-luna',
          '{"gpt-5.5":{"effort":"low"},"gpt-6-luna":{"effort":"high"}}');
    `);

    const deepseekProvider = randomUUID();
    const openaiProvider = randomUUID();
    await client.query(
      `INSERT INTO model_providers (id, type, org_id, user_id, selected_model)
       VALUES ($1, 'deepseek', 'org-b', 'user-b', 'deepseek-v4-pro'),
              ($2, 'openai-api-key', 'org-b', 'user-b', 'gpt-5.5')`,
      [deepseekProvider, openaiProvider],
    );
    await client.query(
      `INSERT INTO agents (id, org_id, owner, name, selected_model, model_provider_id)
       VALUES ($1, 'org-a', 'user-a', 'agent-a', 'claude-opus-4-8', NULL),
              ($2, 'org-b', 'user-b', 'agent-b', 'deepseek-v4-pro', $3),
              ($4, 'org-b', 'user-b', 'agent-c', 'gpt-5.5', $5)`,
      [
        randomUUID(),
        randomUUID(),
        deepseekProvider,
        randomUUID(),
        openaiProvider,
      ],
    );
    await client.query(
      `INSERT INTO agent_runs (
        status, prompt, user_id, org_id, session_id, trigger_source,
        autonomy_budget, selected_model, model_provider, reasoning_effort,
        completed_at
      ) VALUES ('completed', 'Historical prompt', 'user-a', 'org-a', $1,
        'chat', 0, 'claude-opus-4-8', 'built-in', 'extra', '2026-09-01')`,
      [randomUUID()],
    );
    await client.query(
      `INSERT INTO usage_event (
        idempotency_key, org_id, user_id, kind, provider, category, quantity
      ) VALUES ($1, 'org-b', 'user-b', 'model', 'deepseek-v4-pro',
        'tokens.input', 100)`,
      [randomUUID()],
    );

    const beforeRuns = await rows("agent_runs", "id");
    const beforeUsage = await rows("usage_event", "id");
    const migration = await readFile(
      new URL(MIGRATION_FILE, import.meta.url),
      "utf8",
    );
    await applyMigration(migration);

    assert.deepEqual(
      (await rows("org_model_policies", "org_id, model")).map((row) => {
        return [
          row.org_id,
          row.model,
          row.is_default,
          row.default_provider_type,
          row.credential_scope,
        ];
      }),
      [
        [
          "org-a",
          "claude-opus-5-5",
          false,
          "claude-code-oauth-token",
          "member",
        ],
        ["org-a", "gpt-6-luna", true, "built-in", "org"],
        ["org-b", "gpt-6-luna", false, "built-in", "org"],
        ["org-c", "gpt-6-luna", true, "built-in", "org"],
        ["org-d", "gpt-6-luna", true, "built-in", "org"],
      ],
    );

    // Effort carries over when accepted, otherwise the route default applies;
    // an existing replacement preference wins. Retired keys stay.
    assert.deepEqual(
      (await rows("org_members_metadata", "org_id")).map((row) => {
        return [row.selected_model, row.model_settings];
      }),
      [
        [
          "claude-opus-5-5",
          {
            "claude-opus-4-8": { effort: "extra" },
            "claude-opus-5-5": { effort: "extra" },
          },
        ],
        [
          "gpt-6-luna",
          {
            "deepseek-v4-pro": { effort: "ultra" },
            "gpt-5.5": { effort: "low" },
            "gpt-6-luna": { effort: "max" },
          },
        ],
        [
          "gpt-6-luna",
          { "gpt-5.5": { effort: "low" }, "gpt-6-luna": { effort: "high" } },
        ],
      ],
    );

    // A DeepSeek connection cannot serve gpt-6-luna: its selections stay for
    // the API to resolve and reject explicitly.
    assert.deepEqual(
      (await rows("agents", "name")).map((row) => {
        return row.selected_model;
      }),
      ["claude-opus-5-5", "deepseek-v4-pro", "gpt-6-luna"],
    );
    assert.deepEqual(
      (await rows("model_providers", "type")).map((row) => {
        return [row.type, row.selected_model];
      }),
      [
        ["deepseek", "deepseek-v4-pro"],
        ["openai-api-key", "gpt-6-luna"],
      ],
    );

    assert.deepEqual(await rows("agent_runs", "id"), beforeRuns);
    assert.deepEqual(await rows("usage_event", "id"), beforeUsage);

    const afterFirstRun = await snapshot();
    await applyMigration(migration);
    assert.deepEqual(await snapshot(), afterFirstRun);

    console.log(
      "   ✅ Stored model selections: chain resolution, policy merge, cross-provider drop, effort conversion, history preservation and idempotency passed",
    );
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert.ok(
    process.env.DATABASE_URL,
    "DATABASE_URL is required (migrated local test database)",
  );
  await validateModelCatalogStoredSelections(process.env.DATABASE_URL);
}
