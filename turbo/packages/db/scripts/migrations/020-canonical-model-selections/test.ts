import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { Client } from "pg";
import {
  migrateEventSnapshot,
  migrateThreadSnapshot,
  scopePrefix,
  sha256,
} from "./model";
import { storageStateSchema } from "./test-storage";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const name = `selection_blob_${randomUUID().replaceAll("-", "")}`;
const admin = new Client({ connectionString: databaseUrl });
await admin.connect();
await admin.query(`CREATE DATABASE "${name}"`);
const url = new URL(databaseUrl);
url.pathname = `/${name}`;
const db = new Client({ connectionString: url.toString() });
await db.connect();
const dir = await mkdtemp(join(tmpdir(), "selection020-"));
const file = join(dir, "storage.json");
const user = "selection-owner";
const org = "selection-org";
const thread = randomUUID();
const agent = randomUUID();
const eventId = randomUUID();
const env = {
  ...process.env,
  DATABASE_URL: url.toString(),
  R2_ACCOUNT_ID: "selection020-test",
  R2_ACCESS_KEY_ID: "test-key",
  R2_SECRET_ACCESS_KEY: "test-secret",
  R2_USER_STORAGES_BUCKET_NAME: "selection020-test-bucket",
  MODEL_SELECTION_TEST_STORAGE: file,
};
const cli = (extra: string[] = []) => {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      fileURLToPath(new URL("test-storage.ts", import.meta.url)),
      fileURLToPath(new URL("backfill.ts", import.meta.url)),
      "--user-id",
      user,
      "--org-id",
      org,
      ...extra,
    ],
    { env, encoding: "utf8" },
  );
};
async function state() {
  return storageStateSchema.parse(JSON.parse(await readFile(file, "utf8")));
}
const projection = {
  id: thread,
  agentId: agent,
  title: "keep",
  sortAt: "2026-01-01",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  pinnedAt: null,
  archived: false,
  renamedAt: null,
  selectedModel: null,
  modelSettings: {
    "okou-1.0-pro": { effort: "high" },
    "@preset/old": { effort: "xhigh" },
    "gpt-6-luna": { effort: "medium" },
  },
  serviceTier: null,
};
const original = gzipSync(
  Buffer.from(
    JSON.stringify({
      chatThreads: [projection],
      preservedExtension: { transport: "openai-responses" },
    }),
  ),
);
const oldKey = `${scopePrefix(user, org)}10-${sha256(original)}.json.gz`;
try {
  // Frozen pointer/owner columns; actual PostgreSQL CAS and AWS SDK HTTP calls.
  await db.query(`CREATE TABLE chat_thread_snapshots (user_id text, org_id text, latest_event_id uuid, latest_event_seq_id bigint, object_key text, updated_at timestamp, PRIMARY KEY (user_id, org_id));
    CREATE TABLE agents (id uuid PRIMARY KEY, org_id text);
    CREATE TABLE chat_threads (id uuid PRIMARY KEY, user_id text, agent_id uuid);
    CREATE TABLE chat_event_snapshots (id uuid PRIMARY KEY, chat_thread_id uuid, archive_schema_version int, last_seq_id bigint, last_event_id uuid, terminal_event_id uuid, terminal_seq_id bigint, object_key text);`);
  await db.query(
    `INSERT INTO chat_thread_snapshots VALUES ($1, $2, $3, 10, $4, '2026-01-01 00:00:00.123456')`,
    [user, org, eventId, oldKey],
  );
  await writeFile(
    file,
    JSON.stringify({
      objects: { [oldKey]: original.toString("base64") },
      puts: 0,
      advance: null,
      failPut: false,
    }),
  );
  const dry = cli();
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(JSON.parse(dry.stdout), {
    heads: 1,
    changedRows: 1,
    published: 0,
    conflicts: 0,
  });
  assert.equal((await state()).puts, 0);
  const migrate = cli(["--migrate"]);
  assert.equal(migrate.status, 0, migrate.stderr);
  assert.deepEqual(JSON.parse(migrate.stdout), {
    heads: 1,
    changedRows: 1,
    published: 1,
    conflicts: 0,
  });
  const head = (await db.query(`SELECT * FROM chat_thread_snapshots`)).rows[0];
  assert.equal(head.latest_event_seq_id, "10");
  assert.equal(head.latest_event_id, eventId);
  assert.notEqual(head.object_key, oldKey);
  const uploaded = Buffer.from(
    (await state()).objects[head.object_key] ?? "",
    "base64",
  );
  assert.equal(
    head.object_key,
    `${scopePrefix(user, org)}10-${sha256(uploaded)}.json.gz`,
  );
  assert.deepEqual(JSON.parse(gunzipSync(uploaded).toString()), {
    chatThreads: [
      {
        ...projection,
        selectedModel: "auto",
        modelSettings: { "gpt-6-luna": { effort: "medium" } },
      },
    ],
    preservedExtension: { transport: "openai-responses" },
  });
  assert.equal(
    (await state()).objects[oldKey],
    original.toString("base64"),
    "original history stays immutable",
  );
  const rerun = cli(["--migrate"]);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(JSON.parse(rerun.stdout).changedRows, 0);
  assert.equal((await state()).puts, 1);
  // Failed upload leaves the pointer untouched and retry publishes normally.
  await db.query(
    `UPDATE chat_thread_snapshots SET object_key = $1, updated_at = now()`,
    [oldKey],
  );
  await writeFile(
    file,
    JSON.stringify({
      ...(await state()),
      failPut: true,
      objects: { [oldKey]: original.toString("base64") },
    }),
  );
  const failed = cli(["--migrate"]);
  assert.notEqual(failed.status, 0);
  assert.equal(
    (await db.query(`SELECT object_key FROM chat_thread_snapshots`)).rows[0]
      .object_key,
    oldKey,
  );
  await writeFile(file, JSON.stringify({ ...(await state()), failPut: false }));
  const recovered = cli(["--migrate"]);
  assert.equal(recovered.status, 0, recovered.stderr);
  // Concurrent compaction wins. The stale migration leaves an orphan immutable
  // destination, and a retry can reuse its identical conditional-PUT result.
  await db.query(
    `UPDATE chat_thread_snapshots SET object_key = $1, updated_at = now()`,
    [oldKey],
  );
  const canonical = migrateThreadSnapshot(original).body;
  const advancedKey = `${scopePrefix(user, org)}11-${sha256(canonical)}.json.gz`;
  await writeFile(
    file,
    JSON.stringify({
      ...(await state()),
      objects: {
        [oldKey]: original.toString("base64"),
        [advancedKey]: canonical.toString("base64"),
      },
      advance: { user, org, key: advancedKey, seq: 11 },
    }),
  );
  const conflict = cli(["--migrate"]);
  assert.equal(conflict.status, 2, conflict.stderr);
  assert.equal(JSON.parse(conflict.stdout).conflicts, 1);
  assert.equal(
    (await db.query(`SELECT object_key FROM chat_thread_snapshots`)).rows[0]
      .object_key,
    advancedKey,
  );
  const reconcile = cli(["--migrate"]);
  assert.equal(reconcile.status, 0, reconcile.stderr);
  assert.equal(JSON.parse(reconcile.stdout).changedRows, 0);
  await db.query(
    `UPDATE chat_thread_snapshots SET object_key = $1, latest_event_seq_id = 10, updated_at = now()`,
    [oldKey],
  );
  const reuse = cli(["--migrate"]);
  assert.equal(reuse.status, 0, reuse.stderr);
  assert.equal(JSON.parse(reuse.stdout).published, 1);
  // Wrong-owner and corrupt content cannot be republished.
  const foreign = `${scopePrefix("other-owner", org)}10-${sha256(original)}.json.gz`;
  await db.query(`UPDATE chat_thread_snapshots SET object_key = $1`, [foreign]);
  assert.notEqual(cli(["--migrate"]).status, 0);
  await db.query(`UPDATE chat_thread_snapshots SET object_key = $1`, [oldKey]);
  await writeFile(
    file,
    JSON.stringify({
      ...(await state()),
      objects: {
        [oldKey]: gzipSync(Buffer.from("corrupt")).toString("base64"),
      },
    }),
  );
  assert.notEqual(cli(["--migrate"]).status, 0);
  // V8 NDJSON retains framing, ordering, cursors and non-model payloads.
  const first = randomUUID();
  const last = randomUUID();
  const base = {
    chatThreadId: thread,
    runId: null,
    revokesEventId: null,
    contextType: "web",
    contextId: null,
    runEventSequenceNumber: null,
    runEventId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const rows = [
    {
      ...base,
      id: first,
      seqId: 2,
      eventType: "input.prompt",
      payload: {
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: "keep" },
            { type: "model", selectedModel: "okou-1.0" },
            {
              type: "model",
              selectedModel: "okou-1.0-pro",
              serviceTier: "fast",
            },
            { type: "model", selectedModel: "okou-1.0-max" },
            { type: "model", selectedModel: "gpt-6-sol", serviceTier: "fast" },
          ],
        },
      },
    },
    {
      ...base,
      id: last,
      seqId: 7,
      eventType: "output.message",
      payload: { content: "keep-output" },
    },
  ];
  const eventBody = gzipSync(
    Buffer.from(
      rows
        .map((r) => {
          return JSON.stringify(r);
        })
        .join("\n") + "\n",
    ),
  );
  const eventKey = `chat-events/${thread}/9-r1-${sha256(eventBody)}.ndjson.gz`;
  await db.query(`INSERT INTO agents VALUES ($1,$2)`, [agent, org]);
  await db.query(`INSERT INTO chat_threads VALUES ($1,$2,$3)`, [
    thread,
    user,
    agent,
  ]);
  await db.query(
    `INSERT INTO chat_event_snapshots VALUES ($1,$2,8,9,$3,$4,7,$5)`,
    [randomUUID(), thread, eventId, last, eventKey],
  );
  await writeFile(
    file,
    JSON.stringify({
      objects: { [eventKey]: eventBody.toString("base64") },
      puts: 0,
      advance: null,
      failPut: false,
    }),
  );
  const inventory = (extra: string[]) => {
    return spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        fileURLToPath(new URL("test-storage.ts", import.meta.url)),
        fileURLToPath(
          new URL(
            "../021-model-identity-finalization/snapshots.ts",
            import.meta.url,
          ),
        ),
        "--kind",
        "events",
        "--limit",
        "1",
        ...extra,
      ],
      { env, encoding: "utf8" },
    );
  };
  const inventoryDry = inventory([]);
  assert.equal(inventoryDry.status, 0, inventoryDry.stderr);
  assert.equal(JSON.parse(inventoryDry.stdout).changedRows, 1);
  assert.equal((await state()).puts, 0);
  const publishedPage = inventory(["--migrate"]);
  assert.equal(publishedPage.status, 0, publishedPage.stderr);
  assert.equal(JSON.parse(publishedPage.stdout).published, 1);
  const exhausted = inventory([
    "--after",
    JSON.parse(publishedPage.stdout).nextCursor,
  ]);
  assert.equal(exhausted.status, 0, exhausted.stderr);
  assert.equal(JSON.parse(exhausted.stdout).scanned, 0);
  assert.equal(JSON.parse(inventory([]).stdout).changedRows, 0);
  const eventRun = cli(["--thread-id", thread, "--migrate"]);
  assert.equal(eventRun.status, 0, eventRun.stderr);
  const eventHead = (await db.query(`SELECT * FROM chat_event_snapshots`))
    .rows[0];
  const migratedEvents = gunzipSync(
    Buffer.from((await state()).objects[eventHead.object_key] ?? "", "base64"),
  ).toString();
  const migratedRows = migratedEvents
    .trimEnd()
    .split("\n")
    .map((r) => {
      return JSON.parse(r);
    });
  assert.equal(
    migratedRows[0].payload.userMessage.parts[1].selectedModel,
    "auto",
  );
  assert.deepEqual(migratedRows[0].payload.userMessage.parts, [
    { type: "text", text: "keep" },
    { type: "model", selectedModel: "auto" },
    { type: "model", selectedModel: "auto" },
    { type: "model", selectedModel: "auto" },
    { type: "model", selectedModel: "gpt-6-sol", serviceTier: "fast" },
  ]);
  assert.deepEqual(migratedRows[1], rows[1]);
  assert.equal(eventHead.terminal_seq_id, "7");
  assert.equal(eventHead.last_seq_id, "9");
  assert.throws(() => {
    return migrateEventSnapshot(eventBody, randomUUID(), 9, last, 7);
  }, /scope_or_order/);
  assert.throws(() => {
    return migrateEventSnapshot(eventBody, thread, 9, first, 2);
  }, /terminal_cursor/);
  assert.equal(
    migrateEventSnapshot(
      migrateEventSnapshot(eventBody, thread, 9, last, 7).body,
      thread,
      9,
      last,
      7,
    ).changed,
    0,
  );
  console.log(
    "canonical model snapshots: CLI dry-run, immutable upload, CAS, reconciliation, ownership and V8 replay passed",
  );
} finally {
  await db.end();
  await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
  await rm(dir, { recursive: true, force: true });
}
