import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Client } from "pg";
import { z } from "zod";

const MIGRATION_FILE =
  "../src/migrations/1213_retire_sonnet_4_6_opus_4_8_deepseek_v4_pro.sql";

export async function validateSonnet46Opus48DeepSeekV4ProRetirement(
  databaseUrl: string,
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const schema = `model_retirement_${randomUUID().replaceAll("-", "")}`;
  const tables = [
    "run_model_catalog",
    "org_model_policies",
    "org_members_metadata",
    "agents",
    "model_providers",
    "chat_threads",
    "chat_thread_events",
    "chat_thread_event_sequences",
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
      "DROP TABLE pg_temp.model_retirement_map, pg_temp.model_retirement_threads",
    );
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

    await client.query(`
      INSERT INTO run_model_catalog (model, allow_new_org_policy)
      VALUES ('claude-sonnet-4-6', true), ('claude-opus-4-8', false),
             ('claude-sonnet-5', true), ('claude-opus-5-5', true);
      -- Target exists: the retired default moves to the existing target.
      -- Target missing: the retired row is renamed with its member route.
      INSERT INTO org_model_policies (
        org_id, model, is_default, default_provider_type, credential_scope
      ) VALUES
        ('org-a', 'claude-sonnet-4-6', true, 'built-in', 'org'),
        ('org-a', 'claude-sonnet-5', false, 'built-in', 'org'),
        ('org-a', 'claude-opus-4-8', false, 'claude-code-oauth-token', 'member'),
        ('org-b', 'deepseek-v4-pro', true, 'built-in', 'org'),
        ('org-b', 'gpt-6-luna', false, 'built-in', 'org'),
        ('org-c', 'claude-opus-4-8', false, 'built-in', 'org'),
        ('org-c', 'claude-opus-5-5', true, 'built-in', 'org');
      INSERT INTO org_members_metadata (
        org_id, user_id, selected_model, model_settings
      ) VALUES
        ('org-a', 'user-a', 'claude-sonnet-4-6',
          '{"claude-sonnet-4-6":{"effort":"max"},"claude-opus-4-8":{"effort":"extra"}}'),
        ('org-b', 'user-b', 'gpt-6-luna', '{"deepseek-v4-pro":{"effort":"high"}}');
    `);

    const agentA = randomUUID();
    const agentB = randomUUID();
    await client.query(
      `INSERT INTO agents (id, org_id, owner, name, selected_model)
       VALUES ($1, 'org-a', 'user-a', 'agent-a', 'claude-opus-4-8'),
              ($2, 'org-b', 'user-b', 'agent-b', NULL)`,
      [agentA, agentB],
    );
    const providerId = randomUUID();
    await client.query(
      `INSERT INTO model_providers (id, type, org_id, user_id, selected_model)
       VALUES ($1, 'deepseek', 'org-b', 'user-b', 'deepseek-v4-pro')`,
      [providerId],
    );

    const threadSonnet = randomUUID();
    const threadOpus = randomUUID();
    const threadDeepSeek = randomUUID();
    const threadActive = randomUUID();
    const threadAgentless = randomUUID();
    for (const [id, userId, agentId, model] of [
      [threadSonnet, "user-a", agentA, "claude-sonnet-4-6"],
      [threadOpus, "user-a", agentA, "claude-opus-4-8"],
      [threadDeepSeek, "user-b", agentB, "deepseek-v4-pro"],
      [threadActive, "user-a", agentA, "claude-sonnet-5"],
      [threadAgentless, "user-a", null, "claude-sonnet-4-6"],
    ]) {
      await client.query(
        `INSERT INTO chat_threads (
          id, user_id, agent_id, selected_model, model_provider_type,
          model_provider_credential_scope, reasoning_effort, model_settings,
          updated_at, last_message_at
        ) VALUES ($1, $2, $3, $4, 'built-in', 'org', 'high',
          '{"claude-sonnet-4-6":{"effort":"max"}}', '2026-09-01', '2026-09-01')`,
        [id, userId, agentId, model],
      );
    }
    // user-a already has thread events; user-b has no sequence row yet.
    await client.query(
      `INSERT INTO chat_thread_event_sequences (user_id, org_id, last_seq_id)
       VALUES ('user-a', 'org-a', 7)`,
    );
    await client.query(
      `INSERT INTO chat_thread_events (
        user_id, org_id, chat_thread_id, kind, seq_id, agent_id, selected_model,
        created_at
      ) VALUES ('user-a', 'org-a', $1, 'model_selection_updated', 7, $2,
        'claude-sonnet-4-6', '2026-09-01')`,
      [threadSonnet, agentA],
    );
    await client.query(
      `INSERT INTO agent_runs (
        status, prompt, user_id, org_id, session_id, trigger_source,
        autonomy_budget, selected_model, model_provider, completed_at
      ) VALUES ('completed', 'Historical prompt', 'user-a', 'org-a', $1,
        'chat', 0, 'claude-opus-4-8', 'built-in', '2026-09-01')`,
      [randomUUID()],
    );
    await client.query(
      `INSERT INTO usage_event (
        idempotency_key, org_id, user_id, kind, provider, category, quantity
      ) VALUES ($1, 'org-a', 'user-a', 'model', 'claude-sonnet-4-6',
        'tokens.input', 100)`,
      [randomUUID()],
    );

    const migration = await readFile(
      new URL(MIGRATION_FILE, import.meta.url),
      "utf8",
    );

    // Postcondition: a reference that survives the mapping fails atomically.
    const before = await snapshot();
    await client.query("SAVEPOINT retained_reference");
    await client.query(`
      CREATE FUNCTION pg_temp.keep_selected_model() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        NEW.selected_model := OLD.selected_model;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER keep_selected_model BEFORE UPDATE ON org_members_metadata
        FOR EACH ROW EXECUTE FUNCTION pg_temp.keep_selected_model();
    `);
    await assert.rejects(client.query(migration), {
      message:
        "Model retirement left 1 references and 0 organizations with multiple defaults",
    });
    await client.query("ROLLBACK TO SAVEPOINT retained_reference");
    await client.query("RELEASE SAVEPOINT retained_reference");
    assert.deepEqual(await snapshot(), before);

    const beforeThreads = await rows("chat_threads", "id");
    const beforeMembers = await rows("org_members_metadata", "org_id");
    await applyMigration(migration);

    assert.deepEqual(
      (await rows("run_model_catalog", "model")).map((row) => {
        return [row.model, row.allow_new_org_policy];
      }),
      [
        ["claude-opus-4-8", false],
        ["claude-opus-5-5", true],
        ["claude-sonnet-4-6", false],
        ["claude-sonnet-5", true],
      ],
    );
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
        ["org-a", "claude-sonnet-5", true, "built-in", "org"],
        ["org-b", "deepseek-v4.1-flash", true, "built-in", "org"],
        ["org-b", "gpt-6-luna", false, "built-in", "org"],
        ["org-c", "claude-opus-5-5", true, "built-in", "org"],
      ],
    );

    // Selections move; per-model settings keys stay parseable history.
    const members = await rows("org_members_metadata", "org_id");
    assert.deepEqual(
      members.map((row) => {
        return [row.selected_model, row.model_settings];
      }),
      [
        ["claude-sonnet-5", beforeMembers[0]?.model_settings],
        ["gpt-6-luna", beforeMembers[1]?.model_settings],
      ],
    );
    assert.deepEqual(
      (await rows("agents", "name")).map((row) => {
        return row.selected_model;
      }),
      ["claude-opus-5-5", null],
    );
    assert.deepEqual(
      (await rows("model_providers", "id")).map((row) => {
        return row.selected_model;
      }),
      ["deepseek-v4.1-flash"],
    );

    const expectedThreadModels = new Map<string, string>([
      [threadSonnet, "claude-sonnet-5"],
      [threadOpus, "claude-opus-5-5"],
      [threadDeepSeek, "deepseek-v4.1-flash"],
      [threadActive, "claude-sonnet-5"],
      [threadAgentless, "claude-sonnet-5"],
    ]);
    for (const thread of await rows("chat_threads", "id")) {
      const original = beforeThreads.find((row) => {
        return row.id === thread.id;
      });
      assert.ok(original);
      const id = z.string().parse(thread.id);
      if (id === threadActive) {
        assert.deepEqual(thread, original);
        continue;
      }
      assert.ok(thread.updated_at instanceof Date);
      assert.ok(original.updated_at instanceof Date);
      assert.ok(thread.updated_at > original.updated_at);
      assert.deepEqual(thread, {
        ...original,
        selected_model: expectedThreadModels.get(id),
        updated_at: thread.updated_at,
      });
    }

    // One event per re-pinned agent-bound thread, contiguous per stream after
    // the existing sequence value.
    const events = await rows("chat_thread_events", "user_id, seq_id");
    assert.deepEqual(
      events.map((row) => {
        return [
          row.user_id,
          row.org_id,
          Number(row.seq_id),
          row.chat_thread_id,
          row.kind,
          row.agent_id,
          row.selected_model,
          row.cloud_browser_enabled,
          row.model_settings,
          row.model_settings_patch,
          row.reasoning_effort,
        ];
      }),
      [
        [
          "user-a",
          "org-a",
          7,
          threadSonnet,
          "model_selection_updated",
          agentA,
          "claude-sonnet-4-6",
          false,
          null,
          null,
          null,
        ],
        ...[
          [threadSonnet, "claude-sonnet-5"],
          [threadOpus, "claude-opus-5-5"],
        ]
          .sort(([left], [right]) => {
            return String(left).localeCompare(String(right));
          })
          .map(([threadId, model], index) => {
            return [
              "user-a",
              "org-a",
              8 + index,
              threadId,
              "model_selection_updated",
              agentA,
              model,
              false,
              null,
              null,
              null,
            ];
          }),
        [
          "user-b",
          "org-b",
          1,
          threadDeepSeek,
          "model_selection_updated",
          agentB,
          "deepseek-v4.1-flash",
          false,
          null,
          null,
          null,
        ],
      ],
    );
    assert.deepEqual(
      (await rows("chat_thread_event_sequences", "user_id")).map((row) => {
        return [row.user_id, row.org_id, Number(row.last_seq_id)];
      }),
      [
        ["user-a", "org-a", 9],
        ["user-b", "org-b", 1],
      ],
    );

    const after = await snapshot();
    for (const table of ["agent_runs", "usage_event"] as const) {
      assert.deepEqual(
        after[tables.indexOf(table)],
        before[tables.indexOf(table)],
      );
    }

    await applyMigration(migration);
    assert.deepEqual(await snapshot(), after);
    console.log(
      "Sonnet 4.6 / Opus 4.8 / DeepSeek V4 Pro retirement: postcondition, policy mapping, selections, thread events, history preservation and idempotency passed",
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
  await validateSonnet46Opus48DeepSeekV4ProRetirement(process.env.DATABASE_URL);
}
