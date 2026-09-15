import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Client } from "pg";
import { z } from "zod";

export async function validateGpt55Retirement(
  databaseUrl: string,
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const schema = `gpt55_retirement_${randomUUID().replaceAll("-", "")}`;
  const tables = [
    "org_model_policies",
    "org_members_metadata",
    "agents",
    "model_providers",
    "chat_threads",
    "model_provider_surfaces",
    "agent_runs",
    "chat_thread_events",
    "usage_event",
  ] as const;
  const rowsSchema = z.array(z.record(z.string(), z.unknown()));

  async function rows(table: (typeof tables)[number]) {
    const result = await client.query(`SELECT * FROM ${table}`);
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

  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    await client.query("SET LOCAL lock_timeout = '1s'");
    await client.query("SET LOCAL statement_timeout = '10s'");
    // Clone the actual migrated schema, including checks, defaults and indexes.
    // LIKE deliberately leaves foreign keys out of these transaction-owned copies.
    for (const table of tables) {
      await client.query(
        `CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`,
      );
    }

    const agentId = randomUUID();
    const providerId = randomUUID();
    const retiredThreadId = randomUUID();
    const aliasThreadId = randomUUID();
    const activeThreadId = randomUUID();
    await client.query(`
    INSERT INTO org_model_policies (org_id, model, is_default)
    VALUES ('retirement-org', 'gpt-5.6-luna', true),
           ('retirement-org', 'gpt-5.5', false);
    INSERT INTO org_model_policies (
      org_id, model, default_provider_type, credential_scope
    ) VALUES ('retirement-org', 'openai/gpt-5.5', 'codex-oauth-token', 'member');
    INSERT INTO org_members_metadata (
      org_id, user_id, selected_model, service_tier, model_settings
    ) VALUES ('retirement-org', 'retirement-user', 'gpt-5.6-luna', 'priority',
      '{"gpt-5.5":{"effort":"xhigh"},"gpt-5.6-luna":{"effort":"low"}}');
  `);
    await client.query(
      `INSERT INTO agents (id, org_id, owner, name)
     VALUES ($1, 'retirement-org', 'retirement-user', 'retirement-agent');`,
      [agentId],
    );
    await client.query(
      `INSERT INTO model_providers (id, type, org_id, user_id, selected_model)
     VALUES ($1, 'openai-api-key', 'retirement-org', 'retirement-user', 'gpt-5.6-luna')`,
      [providerId],
    );
    for (const [id, model] of [
      [retiredThreadId, "gpt-5.5"],
      [aliasThreadId, "openai/gpt-5.5"],
      [activeThreadId, "gpt-5.6-luna"],
    ]) {
      await client.query(
        `INSERT INTO chat_threads (
        id, user_id, agent_id, selected_model, model_provider_id,
        model_provider_type, model_provider_credential_scope, reasoning_effort,
        codex_service_tier, model_settings, updated_at, last_message_at
      ) VALUES ($1, 'retirement-user', $2, $3, $4, 'openai-api-key', 'org',
        'xhigh', 'fast',
        '{"gpt-5.5":{"effort":"xhigh"},"openai/gpt-5.5":{"effort":"high"},"gpt-5.6-luna":{"effort":"low"}}',
        '2026-08-12', '2026-08-12')`,
        [id, agentId, model, providerId],
      );
    }
    await client.query(
      `INSERT INTO model_provider_surfaces (
      connection_id, protocol, api_base_url, auth_header_name,
      auth_header_template, model_mappings
    ) VALUES ($1, 'openai-responses', 'https://gateway.example.test/v1',
      'Authorization', 'Bearer {{secret}}',
      '{"gpt-5.5":"old-deployment","openai/gpt-5.5":"old-alias","gpt-5.6-sol":" OPENAI/GPT-5.5 ","gpt-5.6-luna":"luna-deployment"}')`,
      [randomUUID()],
    );
    await client.query(
      `INSERT INTO agent_runs (
      status, prompt, user_id, org_id, session_id, trigger_source,
      autonomy_budget, selected_model, model_provider, completed_at
    ) VALUES ('completed', 'Historical prompt', 'retirement-user',
      'retirement-org', $1, 'chat', 0, 'gpt-5.5', 'openai-api-key', '2026-08-12')`,
      [randomUUID()],
    );
    await client.query(
      `INSERT INTO chat_thread_events (
      user_id, org_id, chat_thread_id, kind, seq_id, selected_model
    ) VALUES ('retirement-user', 'retirement-org', $1,
      'model_selection_updated', 1, 'gpt-5.5')`,
      [retiredThreadId],
    );
    await client.query(
      `INSERT INTO usage_event (
      idempotency_key, org_id, user_id, kind, provider, category, quantity
    ) VALUES ($1, 'retirement-org', 'retirement-user',
      'model', 'gpt-5.5', 'tokens.input', 100)`,
      [randomUUID()],
    );

    const migration = await readFile(
      new URL("../src/migrations/1143_retire_gpt_5_5.sql", import.meta.url),
      "utf8",
    );
    const before = await snapshot();
    for (const unexpectedSelection of [
      `UPDATE org_model_policies SET is_default = false;
     UPDATE org_model_policies SET is_default = true WHERE model = 'gpt-5.5'`,
      `UPDATE org_members_metadata SET selected_model = 'gpt-5.5'`,
      `UPDATE agents SET selected_model = 'gpt-5.5'`,
      `UPDATE model_providers SET selected_model = 'openai/gpt-5.5'`,
    ]) {
      await client.query("SAVEPOINT unexpected_selection");
      await client.query(unexpectedSelection);
      await assert.rejects(client.query(migration), {
        message:
          "GPT 5.5 retirement preflight changed; resolve live defaults and preferences before retrying",
      });
      await client.query("ROLLBACK TO SAVEPOINT unexpected_selection");
      await client.query("RELEASE SAVEPOINT unexpected_selection");
      assert.deepEqual(await snapshot(), before);
    }

    const beforeThreads = await rows("chat_threads");
    const beforeMember = await rows("org_members_metadata");
    const beforeSurface = await rows("model_provider_surfaces");
    const beforePolicies = await rows("org_model_policies");
    await client.query(migration);
    assert.deepEqual(
      await rows("org_model_policies"),
      beforePolicies.filter((row) => {
        return row.model === "gpt-5.6-luna";
      }),
    );
    for (const thread of await rows("chat_threads")) {
      const original = beforeThreads.find((row) => {
        return row.id === thread.id;
      });
      assert.ok(original);
      assert.deepEqual(thread, {
        ...original,
        ...(thread.id === activeThreadId
          ? {}
          : {
              selected_model: null,
              model_provider_id: null,
              model_provider_type: null,
              model_provider_credential_scope: null,
              reasoning_effort: null,
              codex_service_tier: null,
            }),
        model_settings: { "gpt-5.6-luna": { effort: "low" } },
      });
    }
    assert.deepEqual(await rows("org_members_metadata"), [
      {
        ...beforeMember[0],
        model_settings: { "gpt-5.6-luna": { effort: "low" } },
      },
    ]);
    assert.deepEqual(await rows("model_provider_surfaces"), [
      {
        ...beforeSurface[0],
        model_mappings: { "gpt-5.6-luna": "luna-deployment" },
      },
    ]);
    const after = await snapshot();
    for (const table of [
      "agents",
      "model_providers",
      "agent_runs",
      "chat_thread_events",
      "usage_event",
    ] as const) {
      assert.deepEqual(
        after[tables.indexOf(table)],
        before[tables.indexOf(table)],
      );
    }
    await client.query(migration);
    assert.deepEqual(await snapshot(), after);
    console.log(
      "GPT 5.5 retirement: preconditions, configuration cleanup, history preservation and idempotency passed",
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
  await validateGpt55Retirement(process.env.DATABASE_URL);
}
