import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Client } from "pg";
import { z } from "zod";

const routeTables = [
  {
    table: "slack_chat_thread_routes",
    identity: "connection_id",
    key: "thread_ts",
    channel: "channel_id",
    hasUser: true,
  },
  {
    table: "feishu_chat_thread_routes",
    identity: "connection_id",
    key: "thread_id",
    channel: "chat_id",
    hasUser: true,
  },
  {
    table: "teams_chat_thread_routes",
    identity: "connection_id",
    key: "thread_id",
    channel: "conversation_id",
    hasUser: true,
  },
  {
    table: "discord_chat_thread_routes",
    identity: "connection_id",
    key: "session_key",
    channel: "channel_id",
    hasUser: true,
  },
  {
    table: "telegram_chat_thread_routes",
    identity: "telegram_official_user_link_id",
    key: "root_message_id",
    channel: "chat_id",
    hasUser: false,
  },
  {
    table: "agentphone_chat_thread_routes",
    identity: "agentphone_user_link_id",
    key: "root_message_id",
    channel: "conversation_id",
    hasUser: false,
  },
] as const;

const rowsSchema = z.array(z.record(z.string(), z.unknown()));

export async function validateIntegrationDmSingleThread(
  databaseUrl: string,
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const schema = `integration_dm_${randomUUID().replaceAll("-", "")}`;
  const tables = [
    "chat_threads",
    ...routeTables.map(({ table }) => {
      return table;
    }),
  ];

  async function rows(table: string) {
    const result = await client.query(`SELECT * FROM ${table} ORDER BY id`);
    return rowsSchema.parse(result.rows);
  }

  async function snapshot() {
    const result: unknown[] = [];
    for (const table of tables) {
      result.push(await rows(table));
    }
    return result;
  }

  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    await client.query("SET LOCAL lock_timeout = '1s'");
    await client.query("SET LOCAL statement_timeout = '10s'");
    // Use the actual migrated table defaults, checks and unique keys. Foreign
    // keys remain owned by public and are intentionally omitted by LIKE.
    for (const table of tables) {
      await client.query(
        `CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`,
      );
    }

    const retainedThreadIds = new Set<string>();
    const removedRouteIds = new Set<string>();
    const retainedRouteIds = new Set<string>();
    for (const route of routeTables) {
      const identity = randomUUID();
      for (const [index, key, lastMessageAt, createdAt] of [
        // The older route was used last, even across platform conversation IDs.
        [0, "direct-message:old-agent:gpt-6-sol", "2026-09-28", "2026-09-01"],
        [1, "direct-message:new-agent:gpt-6-luna", "2026-09-27", "2026-09-27"],
        // An existing canonical key participates in the same recency ranking.
        [2, "direct-message:main", "2026-09-26", "2026-09-26"],
        [3, "reply-thread-123", "2026-09-29", "2026-09-29"],
        // A different connection owns an independent main conversation.
        [4, "direct-message:other-agent:gpt-6-sol", "2026-09-25", "2026-09-25"],
      ] as const) {
        const threadId = randomUUID();
        const routeId = randomUUID();
        await client.query(
          `INSERT INTO chat_threads (
             id, user_id, selected_model, codex_service_tier,
             model_provider_id, model_provider_type,
             model_provider_credential_scope, last_message_at
           ) VALUES ($1, 'dm-user', 'gpt-6-sol', 'fast', $2,
             'openai-api-key', 'org', $3)`,
          [threadId, randomUUID(), lastMessageAt],
        );
        const columns = [
          "id",
          route.identity,
          route.key,
          route.channel,
          "chat_thread_id",
          "created_at",
          ...(route.hasUser ? ["user_id"] : []),
        ];
        const values = [
          routeId,
          index === 4 ? randomUUID() : identity,
          key,
          `channel-${index}`,
          threadId,
          createdAt,
          ...(route.hasUser ? ["dm-user"] : []),
        ];
        const placeholders = values.map((_, valueIndex) => {
          return `$${valueIndex + 1}`;
        });
        await client.query(
          `INSERT INTO ${route.table} (${columns.join(", ")})
           VALUES (${placeholders.join(", ")})`,
          values,
        );
        if (index === 0 || index === 4) {
          retainedThreadIds.add(threadId);
          retainedRouteIds.add(routeId);
        } else if (index !== 3) {
          removedRouteIds.add(routeId);
        }
      }
    }

    // Retired self-hosted Telegram routes and their history remain untouched.
    const retiredThreadId = randomUUID();
    await client.query(
      `INSERT INTO chat_threads (id, user_id, selected_model)
       VALUES ($1, 'retired-user', 'gpt-6-sol');`,
      [retiredThreadId],
    );
    await client.query(
      `INSERT INTO telegram_chat_thread_routes (
         telegram_user_link_id, chat_id, root_message_id, chat_thread_id
       ) VALUES ($1, 'retired-chat', 'direct-message:retired:gpt-6-sol', $2)`,
      [randomUUID(), retiredThreadId],
    );

    const beforeThreads = await rows("chat_threads");
    const beforeRoutes = new Map<string, Awaited<ReturnType<typeof rows>>>();
    for (const { table } of routeTables) {
      beforeRoutes.set(table, await rows(table));
    }
    const migration = await readFile(
      new URL(
        "../src/migrations/1278_integration_dm_single_thread_routes.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await client.query(migration);

    for (const route of routeTables) {
      const before = beforeRoutes.get(route.table);
      assert.ok(before);
      const expected = before
        .filter((row) => {
          return !removedRouteIds.has(String(row.id));
        })
        .map((row) => {
          return retainedRouteIds.has(String(row.id))
            ? { ...row, [route.key]: "direct-message:main" }
            : row;
        });
      assert.deepEqual(await rows(route.table), expected);
    }
    assert.deepEqual(
      await rows("chat_threads"),
      beforeThreads.map((row) => {
        return retainedThreadIds.has(String(row.id))
          ? {
              ...row,
              selected_model: null,
              codex_service_tier: null,
              model_provider_id: null,
              model_provider_type: null,
              model_provider_credential_scope: null,
            }
          : row;
      }),
    );
    const after = await snapshot();
    await client.query(migration);
    assert.deepEqual(await snapshot(), after);
    console.log(
      "Integration DM migration: identity scope, last use, canonical key collisions, model reset, history and idempotency passed",
    );
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  await validateIntegrationDmSingleThread(process.env.DATABASE_URL);
}
