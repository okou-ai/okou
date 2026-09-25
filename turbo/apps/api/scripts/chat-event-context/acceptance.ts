import "./env";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { createUserMessageDocument } from "../../src/signals/services/chat-user-message.service";
import { insertChatEvent } from "../../src/signals/services/chat-event.service";
import { withNativeChatEventThreadTouch } from "../../src/signals/services/native-chat-event-write.service";
import { loadOptionalChatEnrichment } from "../../src/signals/services/queued-launch-enrichment.service";
import { flushLogs } from "../../src/lib/log";
import { assertErasureReplayRejectsDrift } from "./erasure-compatibility";

// Infrastructure acceptance: a server-private context storage failure is
// deliberately not constructible through public APIs. Writers use real
// PostgreSQL and migrated schemas; every row and the database belong to this
// process. No global switch, unrelated row, writer, or DB operation is mocked.
assert.ok(process.env.DATABASE_URL);
assert.ok(
  ["127.0.0.1", "localhost", "postgres"].includes(
    new URL(process.env.DATABASE_URL).hostname,
  ),
);
const suffix = randomUUID().replaceAll("-", "");
const databaseName = `chat_context_${suffix}`;
const databaseUrl = new URL(process.env.DATABASE_URL);
databaseUrl.pathname = `/${databaseName}`;
const admin = new Client({ connectionString: process.env.DATABASE_URL });
const client = new Client({ connectionString: databaseUrl.toString() });
const schema = `chat_context_${suffix}`;
const userId = `context-user-${suffix}`;
const orgId = `context-org-${suffix}`;
const agentId = randomUUID();
const phoneLink = randomUUID();
const canonical = createUserMessageDocument({
  text: "Original text",
  files: [
    { id: randomUUID(), filename: "original.txt", contentType: "text/plain" },
  ],
});
mock.method(console, "log", () => {});
mock.method(globalThis, "fetch", () => {
  return Promise.resolve(new Response("{}", { status: 200 }));
});
const tables = [
  "agents",
  "chat_threads",
  "chat_events",
  "chat_event_sequences",
  "chat_thread_events",
  "chat_thread_event_sequences",
  "chat_agentphone_context",
];

async function thread() {
  const chatThreadId = randomUUID();
  await client.query(
    "INSERT INTO chat_threads(id,user_id,agent_id) VALUES($1,$2,$3)",
    [chatThreadId, userId, agentId],
  );
  return chatThreadId;
}

function agentphoneInput(id: string, chatThreadId: string) {
  return {
    id,
    chatThreadId,
    eventType: "input.prompt",
    userMessage: canonical,
    runId: null,
    agentphoneContext: {
      messageText: "Original text",
      threadContext: "",
      messageId: `message-${id}`,
      rootMessageId: "phone-root",
      conversationId: "conversation",
      groupId: "group-42",
      channel: "imessage",
      isGroup: true,
      phoneHandle: "+15550001001",
      fromNumber: "+15550001001",
      toNumber: "+15550001002",
      userLinkId: phoneLink,
      agentphoneAgentId: "phone-agent",
      publicBrand: "okou",
    },
  } as const;
}

async function count(sql: string, values: readonly unknown[]) {
  const result = await client.query<{ count: number }>(sql, [...values]);
  return result.rows[0]?.count;
}

async function eventCount(eventId: string) {
  return await count(
    "SELECT count(*)::int AS count FROM chat_events WHERE id=$1",
    [eventId],
  );
}

function contextStorageFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.cause instanceof Error &&
    error.cause.message === "context storage failure"
  );
}

async function contextCount(eventId: string) {
  return await count(
    "SELECT count(*)::int AS count FROM chat_agentphone_context WHERE id=$1",
    [eventId],
  );
}

await admin.connect();
try {
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  await promisify(execFile)("node", ["--import", "tsx", "scripts/migrate.ts"], {
    cwd: fileURLToPath(new URL("../../../../packages/db", import.meta.url)),
    env: { ...process.env, DATABASE_URL: databaseUrl.toString() },
    maxBuffer: 20 * 1024 * 1024,
  });
  await client.connect();
  await assertErasureReplayRejectsDrift(drizzle(client));
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}, public`);
  for (const table of tables) {
    await client.query(
      `CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`,
    );
  }
  await client.query(
    "INSERT INTO agents(id,org_id,owner,name) VALUES($1,$2,$3,'context-acceptance')",
    [agentId, orgId, userId],
  );
  const db = drizzle(client);

  const controller = new AbortController();
  const failOptionalLookup = () => {
    return Promise.reject(new Error("optional lookup failure"));
  };
  // Context storage failure cannot be requested by a channel caller. Fail only
  // the context INSERT and observe that the input is rejected, not accepted.
  await client.query(
    `CREATE FUNCTION ${schema}.reject_context() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'context storage failure'; END $$`,
  );
  await client.query(
    `CREATE TRIGGER reject_context BEFORE INSERT ON chat_agentphone_context FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_context()`,
  );
  assert.equal(
    await loadOptionalChatEnrichment(
      "telegram",
      failOptionalLookup,
      () => {
        return "";
      },
      controller.signal,
    ),
    "",
    "unavailable optional enrichment is omitted",
  );
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    loadOptionalChatEnrichment(
      "telegram",
      () => {
        return Promise.reject(cancelled.signal.reason);
      },
      () => {
        return "";
      },
      cancelled.signal,
    ),
    { name: "AbortError" },
  );

  const splitThread = await thread();
  const splitEventId = randomUUID();
  await assert.rejects(
    insertChatEvent(db, agentphoneInput(splitEventId, splitThread), "id"),
    contextStorageFailure,
  );
  assert.equal(
    await eventCount(splitEventId),
    0,
    "a failed required context write leaves no event without context",
  );
  assert.equal(
    await count(
      "SELECT count(*)::int AS count FROM chat_event_sequences WHERE chat_thread_id=$1",
      [splitThread],
    ),
    0,
    "the rejected input reserves no event sequence",
  );

  await client.query("DROP TRIGGER reject_context ON chat_agentphone_context");
  const redelivered = await insertChatEvent(
    db,
    agentphoneInput(splitEventId, splitThread),
    "id",
  );
  assert.equal(redelivered?.id, splitEventId, "redelivery is accepted");
  assert.equal(await eventCount(splitEventId), 1);
  assert.equal(await contextCount(splitEventId), 1);
  assert.equal(
    await insertChatEvent(db, agentphoneInput(splitEventId, splitThread), "id"),
    null,
    "a duplicate delivery after acceptance is idempotent",
  );
  assert.equal(await contextCount(splitEventId), 1);

  const touchThreadId = await thread();
  const committedEventId = randomUUID();
  await client.query(
    `CREATE FUNCTION ${schema}.reject_thread_touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'thread activity storage failure'; END $$`,
  );
  await client.query(
    `CREATE TRIGGER reject_thread_touch BEFORE UPDATE ON chat_threads FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_thread_touch()`,
  );
  const committed = await withNativeChatEventThreadTouch(
    db,
    {
      chatThreadId: touchThreadId,
      createdAt: new Date(),
      eventId: committedEventId,
    },
    async (writer, touchThread) => {
      const appended = await insertChatEvent(
        writer,
        agentphoneInput(committedEventId, touchThreadId),
        "id",
      );
      await touchThread();
      return appended;
    },
  );
  assert.equal(
    await count(
      "SELECT count(*)::int AS count FROM chat_thread_events WHERE chat_thread_id=$1 AND kind='sort_touched'",
      [touchThreadId],
    ),
    1,
    "native activity failure must still attempt the independent sort event",
  );
  assert.equal(
    committed?.id,
    committedEventId,
    "a weak thread-activity failure must not roll back the event append",
  );
  assert.equal(await contextCount(committedEventId), 1);
  process.stdout.write(
    "Chat context acceptance passed: required context failures reject input and redelivery is accepted.\n",
  );
} finally {
  await flushLogs();
  await client.end();
  await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin.end();
  mock.restoreAll();
}
