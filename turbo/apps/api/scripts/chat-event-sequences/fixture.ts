import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

/** Owned-schema infrastructure fixture: actual allocator SQL, no mocked DB. */
export async function createSequenceFixture() {
  const connectionString = process.env.DATABASE_URL;
  assert.ok(connectionString, "DATABASE_URL is required");
  assert.ok(
    ["127.0.0.1", "localhost", "postgres"].includes(
      new URL(connectionString).hostname,
    ),
  );
  const schema = `chat_event_sequence_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({
    connectionString,
    options: `-c search_path=${schema} -c statement_timeout=10000`,
    max: 10,
  });
  await pool.query(`
    CREATE TABLE chat_threads (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      last_chat_event_seq_id bigint NOT NULL DEFAULT 0
    );
    CREATE TABLE chat_event_sequences (
      chat_thread_id uuid PRIMARY KEY REFERENCES chat_threads(id) ON DELETE CASCADE,
      last_seq_id bigint NOT NULL CHECK(last_seq_id >= 0)
    );
    CREATE TABLE chat_event_write_control (
      id text PRIMARY KEY DEFAULT 'global' CHECK(id = 'global'),
      activated_at timestamp
    );
    CREATE TABLE chat_events (
      id uuid PRIMARY KEY,
      chat_thread_id uuid NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      run_id uuid,
      revokes_event_id uuid UNIQUE,
      event_type text NOT NULL CHECK(event_type IN ('output.message', 'run.completed', 'run.failed', 'run.cancelled', 'control.revoke')),
      payload jsonb, failure_reason text, required_official_workflow_ids uuid[],
      context_type text, context_id uuid, run_event_sequence_number integer,
      run_event_id text, seq_id bigint NOT NULL, created_at timestamp NOT NULL,
      UNIQUE(chat_thread_id, seq_id), UNIQUE(run_id, run_event_sequence_number)
    );
    CREATE UNIQUE INDEX chat_events_run_terminal_unique ON chat_events(run_id)
      WHERE event_type IN ('run.completed', 'run.failed', 'run.cancelled');
  `);
  return {
    schema,
    pool,
    db: drizzle(pool),
    async close() {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    },
  };
}

export async function sequenceMigration(name: string): Promise<string[]> {
  const directory = new URL(
    "../../../../packages/db/src/migrations/",
    import.meta.url,
  );
  const files = await readdir(directory);
  const file = files.find((entry) => {
    return entry.endsWith(`_${name}.sql`);
  });
  assert.ok(file, `Missing generated ${name} migration`);
  return (await readFile(new URL(file, directory), "utf8"))
    .split("--> statement-breakpoint")
    .filter((part) => {
      return part.trim() !== "";
    });
}
