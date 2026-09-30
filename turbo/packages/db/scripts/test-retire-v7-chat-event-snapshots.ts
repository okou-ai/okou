import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import postgres from "postgres";
import { applyPendingMigrations } from "./migration-runner";

// The contraction is tested on a random, test-owned database, never DATABASE_URL.
const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required for a disposable database");
const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
const fixtureUrl = new URL(adminUrl);
const database = `snapshot_retirement_${randomUUID().replaceAll("-", "")}`;
fixtureUrl.pathname = `/${database}`;
const journal: unknown = JSON.parse(
  readFileSync(
    new URL("../src/migrations/meta/_journal.json", import.meta.url),
    "utf8",
  ),
);
assert.ok(
  typeof journal === "object" && journal !== null && "entries" in journal,
);
assert.ok(Array.isArray(journal.entries));
const entry: unknown = journal.entries.find((candidate: unknown) => {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    "tag" in candidate &&
    candidate.tag === "1294_retire_v7_chat_event_snapshots"
  );
});
assert.ok(
  typeof entry === "object" &&
    entry !== null &&
    "when" in entry &&
    typeof entry.when === "number",
);
const migrationMillis = entry.when;
const pointerCount = 6001;
const agentId = randomUUID();

async function migrate(beforeMillis?: number): Promise<void> {
  const sql = postgres(fixtureUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    await applyPendingMigrations(sql, { beforeMillis });
  } finally {
    await sql.end();
  }
}

async function pointers(client: Client, version: number): Promise<unknown[]> {
  const result = await client.query(
    `SELECT * FROM chat_event_snapshots WHERE archive_schema_version = $1 ORDER BY id`,
    [version],
  );
  return result.rows;
}

const admin = new Client({ connectionString: adminUrl.toString() });
await admin.connect();
try {
  await admin.query(`CREATE DATABASE "${database}"`);
  await migrate(migrationMillis);
  const client = new Client({ connectionString: fixtureUrl.toString() });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO agents (id, org_id, owner, name)
       VALUES ($1, 'snapshot-retirement-org', 'snapshot-retirement-user', 'Snapshot retirement')`,
      [agentId],
    );
    const threads = await client.query<{ id: string }>(
      `INSERT INTO chat_threads (user_id, agent_id, title)
       SELECT 'snapshot-retirement-user', $1, 'Snapshot retirement ' || n
       FROM generate_series(1, $2) AS n RETURNING id::text AS id`,
      [agentId, pointerCount],
    );
    const threadIds = threads.rows.map((row) => {
      return row.id;
    });
    await client.query(
      `INSERT INTO chat_event_snapshots (
         id, chat_thread_id, last_seq_id, last_event_id,
         terminal_event_id, terminal_seq_id, archive_schema_version, object_key
       ) SELECT
         ('10000000-0000-4000-8000-' || lpad(pointer.ordinality::text, 12, '0'))::uuid,
         pointer.thread_id, 1, gen_random_uuid(), NULL, 0, 7,
         'chat-events/' || pointer.thread_id::text || '/v7-test.ndjson.gz'
       FROM unnest($1::uuid[]) WITH ORDINALITY AS pointer(thread_id, ordinality)`,
      [threadIds],
    );
    // Include the valid minimum UUID so the primary-key walk cannot omit it.
    await client.query(`UPDATE chat_event_snapshots SET id = '00000000-0000-0000-0000-000000000000'
      WHERE id = '10000000-0000-4000-8000-000000000001'`);
    const originalV7 = await pointers(client, 7);
    await assert.rejects(
      migrate(),
      /Cannot retire V7 Chat Event Snapshot pointers/u,
    );
    assert.deepEqual(await pointers(client, 7), originalV7);
    const journalAfterFailure = await client.query(
      `SELECT created_at FROM drizzle.__drizzle_migrations WHERE created_at = $1`,
      [migrationMillis],
    );
    assert.deepEqual(journalAfterFailure.rows, []);
    await client.query(
      `INSERT INTO chat_event_snapshots (
         id, chat_thread_id, last_seq_id, last_event_id,
         terminal_event_id, terminal_seq_id, archive_schema_version, object_key
       ) SELECT
         ('20000000-0000-4000-8000-' || lpad(pointer.ordinality::text, 12, '0'))::uuid,
         pointer.thread_id, 1, gen_random_uuid(), NULL, 0, 8,
         'chat-events/' || pointer.thread_id::text || '/v8-test.ndjson.gz'
       FROM unnest($1::uuid[]) WITH ORDINALITY AS pointer(thread_id, ordinality)`,
      [threadIds],
    );
    const originalV8 = await pointers(client, 8);
    await client.query(`
      CREATE TABLE public.test_snapshot_delete_batches (transaction_id bigint NOT NULL);
      CREATE FUNCTION public.test_record_snapshot_delete_batch()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO public.test_snapshot_delete_batches VALUES (txid_current());
        RETURN OLD;
      END;
      $$;
      CREATE TRIGGER test_snapshot_delete_batch BEFORE DELETE ON public.chat_event_snapshots
      FOR EACH ROW WHEN (OLD.archive_schema_version = 7)
      EXECUTE FUNCTION public.test_record_snapshot_delete_batch();
    `);
    await migrate();
    assert.deepEqual(await pointers(client, 7), []);
    assert.deepEqual(await pointers(client, 8), originalV8);
    const batches = await client.query(
      `SELECT count(DISTINCT transaction_id)::integer AS count,
         count(*)::integer AS "rowCount" FROM public.test_snapshot_delete_batches`,
    );
    assert.deepEqual(batches.rows, [{ count: 2, rowCount: pointerCount }]);
    const constraint = await client.query(
      `SELECT convalidated AS validated, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint WHERE conrelid = 'public.chat_event_snapshots'::regclass
         AND conname = 'chat_event_snapshots_archive_schema_version_check'`,
    );
    assert.deepEqual(constraint.rows, [
      { validated: true, definition: "CHECK ((archive_schema_version = 8))" },
    ]);
    await client.query(
      `DELETE FROM drizzle.__drizzle_migrations WHERE created_at = $1`,
      [migrationMillis],
    );
    await migrate();
    assert.deepEqual(await pointers(client, 7), []);
    assert.deepEqual(await pointers(client, 8), originalV8);
    console.log(
      "PASS missing V8 fails closed; 6,001 pointers deleted in committed batches; validated V8 constraint; V8 unchanged; retry is a no-op",
    );
  } finally {
    await client.end();
  }
} finally {
  await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin.end();
}
