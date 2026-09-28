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
    "agents",
    "chat_threads",
    "chat_thread_events",
    "chat_thread_event_sequences",
    ...routeTables.map(({ table }) => {
      return table;
    }),
  ];

  async function rows(table: string) {
    const order =
      table === "chat_thread_event_sequences" ? "user_id, org_id" : "id";
    const result = await client.query(
      `SELECT * FROM ${table} ORDER BY ${order}`,
    );
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
    const agentA = randomUUID();
    const agentB = randomUUID();
    await client.query(
      `INSERT INTO agents (id, org_id, owner, name)
       VALUES ($1, 'org-a', 'dm-user', 'agent-a'),
              ($2, 'org-b', 'dm-user', 'agent-b')`,
      [agentA, agentB],
    );
    // Cover an existing stream, a new user in the same org, and the same user
    // in a different org. The latter two have no sequence row before migration.
    const scopes = [
      { userId: "dm-user", orgId: "org-a", agentId: agentA, lastSeqId: 7 },
      { userId: "other-user", orgId: "org-a", agentId: agentA, lastSeqId: 0 },
      { userId: "dm-user", orgId: "org-b", agentId: agentB, lastSeqId: 0 },
    ] as const;
    await client.query(
      `INSERT INTO chat_thread_event_sequences (user_id, org_id, last_seq_id)
       VALUES ('dm-user', 'org-a', 7)`,
    );
    const expectedResetEvents: {
      threadId: string;
      userId: string;
      orgId: string;
      agentId: string;
      kind: string;
    }[] = [];
    // The second identity on each platform covers both pins, model only,
    // tier only, provider only, already unpinned, and an agentless thread.
    const secondaryPins = [
      ["gpt-6-sol", "fast", true],
      ["gpt-6-sol", null, true],
      [null, "fast", true],
      [null, null, true],
      [null, null, false],
      ["gpt-6-sol", "fast", true],
    ] as const;
    async function seedThreadWithModelPin(args: {
      readonly routeIndex: number;
      readonly routeTable: string;
      readonly threadIndex: number;
      readonly lastMessageAt: string;
    }) {
      const { routeIndex, routeTable, threadIndex, lastMessageAt } = args;
      const threadId = randomUUID();
      const scope =
        threadIndex !== 4 ? scopes[0] : scopes[routeIndex % 2 === 0 ? 2 : 1];
      const pins = secondaryPins[threadIndex === 4 ? routeIndex : 0];
      assert.ok(pins);
      const [selectedModel, serviceTier, hasProvider] = pins;
      const agentId =
        threadIndex === 4 && routeTable === "agentphone_chat_thread_routes"
          ? null
          : scope.agentId;
      await client.query(
        `INSERT INTO chat_threads (
         id, user_id, agent_id, selected_model, codex_service_tier,
         model_provider_id, model_provider_type,
         model_provider_credential_scope, last_message_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          threadId,
          scope.userId,
          agentId,
          selectedModel,
          serviceTier,
          hasProvider ? randomUUID() : null,
          hasProvider ? "openai-api-key" : null,
          hasProvider ? "org" : null,
          lastMessageAt,
        ],
      );
      if (routeIndex === 0 && (threadIndex === 0 || threadIndex === 3)) {
        await client.query(
          `INSERT INTO chat_thread_events (
           user_id, org_id, seq_id, chat_thread_id, kind, agent_id,
           selected_model, service_tier, created_at
         ) VALUES ($1, $2, $3, $4, 'created', $5,
           'gpt-6-sol', 'priority', '2026-09-01')`,
          [
            scope.userId,
            scope.orgId,
            threadIndex === 0 ? 6 : 7,
            threadId,
            agentId,
          ],
        );
      }
      return { threadId, scope, agentId, selectedModel, serviceTier };
    }

    for (const [routeIndex, route] of routeTables.entries()) {
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
        const routeId = randomUUID();
        const { threadId, scope, agentId, selectedModel, serviceTier } =
          await seedThreadWithModelPin({
            routeIndex,
            routeTable: route.table,
            threadIndex: index,
            lastMessageAt,
          });
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
          ...(route.hasUser ? [scope.userId] : []),
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
          if (agentId !== null) {
            const kinds = [
              ...(selectedModel !== null ? ["model_selection_updated"] : []),
              ...(serviceTier !== null ? ["service_tier_updated"] : []),
            ];
            for (const kind of kinds) {
              expectedResetEvents.push({
                threadId,
                userId: scope.userId,
                orgId: scope.orgId,
                agentId,
                kind,
              });
            }
          }
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
    const beforeEvents = await rows("chat_thread_events");
    const beforeRoutes = new Map<string, Awaited<ReturnType<typeof rows>>>();
    for (const { table } of routeTables) {
      beforeRoutes.set(table, await rows(table));
    }
    const migration = await readFile(
      new URL(
        "../src/migrations/1279_integration_dm_single_thread_routes.sql",
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
    const events = await rows("chat_thread_events");
    const beforeEventIds = new Set(
      beforeEvents.map((event) => {
        return event.id;
      }),
    );
    assert.deepEqual(
      events.filter((event) => {
        return beforeEventIds.has(event.id);
      }),
      beforeEvents,
    );
    const resetEvents = events.filter((event) => {
      return !beforeEventIds.has(event.id);
    });
    assert.equal(resetEvents.length, expectedResetEvents.length);
    const sequences = await rows("chat_thread_event_sequences");
    assert.equal(sequences.length, scopes.length);
    for (const scope of scopes) {
      const expected = expectedResetEvents
        .filter((event) => {
          return event.userId === scope.userId && event.orgId === scope.orgId;
        })
        .sort((left, right) => {
          return (
            left.threadId.localeCompare(right.threadId) ||
            left.kind.localeCompare(right.kind)
          );
        });
      const actual = resetEvents
        .filter((event) => {
          return event.user_id === scope.userId && event.org_id === scope.orgId;
        })
        .sort((left, right) => {
          return Number(left.seq_id) - Number(right.seq_id);
        });
      assert.deepEqual(
        actual.map((event) => {
          return [
            event.chat_thread_id,
            event.agent_id,
            event.kind,
            Number(event.seq_id),
            event.selected_model,
            event.service_tier,
          ];
        }),
        expected.map((event, index) => {
          return [
            event.threadId,
            event.agentId,
            event.kind,
            scope.lastSeqId + index + 1,
            null,
            null,
          ];
        }),
      );
      const sequence = sequences.find((row) => {
        return row.user_id === scope.userId && row.org_id === scope.orgId;
      });
      assert.ok(sequence);
      assert.equal(
        Number(sequence.last_seq_id),
        scope.lastSeqId + expected.length,
      );
    }
    const after = await snapshot();
    await client.query(migration);
    assert.deepEqual(await snapshot(), after);
    console.log(
      "Integration DM migration: identity scope, last use, canonical key collisions, model reset events, stream sequences, history and idempotency passed",
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
