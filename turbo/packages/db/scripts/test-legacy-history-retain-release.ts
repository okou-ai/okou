import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { applyPendingMigrations } from "./migration-runner";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const migration = await readFile(
  new URL(
    "../src/migrations/1410_release_legacy_run_history_retains.sql",
    import.meta.url,
  ),
  "utf8",
);
const databaseName = `history_retains_${randomUUID().replaceAll("-", "")}`;
const directory = await mkdtemp(path.join(tmpdir(), "okou-history-retains-"));
const originalDirectory = process.cwd();
const admin = postgres(databaseUrl, { max: 1, onnotice: () => {} });
const url = new URL(databaseUrl);
url.pathname = `/${databaseName}`;
const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });

try {
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  await mkdir(path.join(directory, "src/migrations/meta"), { recursive: true });
  await writeFile(
    path.join(directory, "src/migrations/0000_release.sql"),
    migration,
  );
  await writeFile(
    path.join(directory, "src/migrations/meta/_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: [
        {
          idx: 0,
          version: "7",
          when: 1,
          tag: "0000_release",
          breakpoints: true,
        },
      ],
    }),
  );
  // The migration runner is the caller boundary. These disposable tables model
  // its incoming data, including corrupt accounting that must remain isolated.
  await sql.unsafe(`
    CREATE TABLE agent_runs (
      id uuid PRIMARY KEY, legacy_conversation_history_hash varchar(64),
      status text NOT NULL DEFAULT 'completed', completed_at timestamp,
      framework text, launch_snapshot jsonb, chat_thread_id uuid,
      prompt text NOT NULL DEFAULT 'preserve prompt', result jsonb DEFAULT '{"preserve":true}'
    );
    CREATE TABLE blobs (
      hash varchar(64) PRIMARY KEY, ref_count integer NOT NULL,
      encoding text NOT NULL DEFAULT 'zstd', encoded_size bigint NOT NULL DEFAULT 123
    );
    CREATE TABLE pi_memory_stage1_candidates (
      id integer PRIMARY KEY, source_history_hash varchar(64) REFERENCES blobs(hash), status text
    );
    CREATE TABLE pi_memory_stage1_selections (id integer PRIMARY KEY, source_history_hash text);
    -- A whole first batch is protected; it must not terminate the cursor loop.
    INSERT INTO agent_runs (id, legacy_conversation_history_hash, completed_at, framework, chat_thread_id)
    SELECT ('00000000-0000-0000-0000-' || lpad(i::text,12,'0'))::uuid,
      lpad(to_hex(i),64,'0'), now() - interval '9 days 12 hours', 'pi', gen_random_uuid()
    FROM generate_series(1,500) i;
    INSERT INTO agent_runs (id, legacy_conversation_history_hash, completed_at, framework, launch_snapshot)
    SELECT ('00000000-0000-0000-0000-' || lpad(i::text,12,'0'))::uuid,
      lpad(to_hex(i),64,'0'), now() - interval '11 days', 'codex', '{"schemaVersion":3}'
    FROM generate_series(501,1100) i;
    INSERT INTO agent_runs (id, legacy_conversation_history_hash, completed_at, framework, launch_snapshot)
    SELECT ('00000000-0000-0000-0001-' || lpad(i::text,12,'0'))::uuid,
      lpad(to_hex(2000+i),64,'0'), now() - interval '1 day', 'claude-code', '{"schemaVersion":4}'
    FROM generate_series(1,13) i;
    UPDATE agent_runs SET legacy_conversation_history_hash = lpad(to_hex(2001),64,'0')
      WHERE id IN ('00000000-0000-0000-0001-000000000002', '00000000-0000-0000-0001-000000000003');
    UPDATE agent_runs SET status = 'running', completed_at = NULL WHERE id = '00000000-0000-0000-0001-000000000004';
    UPDATE agent_runs SET status = 'pending', completed_at = NULL WHERE id = '00000000-0000-0000-0001-000000000005';
    UPDATE agent_runs SET status = 'failed', completed_at = NULL WHERE id = '00000000-0000-0000-0001-000000000006';
    UPDATE agent_runs SET launch_snapshot = '{"schemaVersion":5}' WHERE id = '00000000-0000-0000-0001-000000000007';
    UPDATE agent_runs SET launch_snapshot = '{"schemaVersion":6}' WHERE id = '00000000-0000-0000-0001-000000000008';
    UPDATE agent_runs SET framework = 'pi', chat_thread_id = gen_random_uuid(), completed_at = now() - interval '11 days'
      WHERE id = '00000000-0000-0000-0001-000000000012';
    -- The launch framework is authoritative over the captured fallback column.
    UPDATE agent_runs SET launch_snapshot = '{"schemaVersion":4,"framework":"pi"}', chat_thread_id = gen_random_uuid()
      WHERE id = '00000000-0000-0000-0001-000000000013';
    INSERT INTO blobs (hash, ref_count)
      SELECT legacy_conversation_history_hash, count(*) FROM agent_runs GROUP BY legacy_conversation_history_hash;
    INSERT INTO pi_memory_stage1_candidates VALUES
      (1, lpad(to_hex(2001),64,'0'), 'terminal_failure'),
      (2, lpad(to_hex(2001),64,'0'), 'succeeded');
    UPDATE blobs SET ref_count = ref_count + 2 WHERE hash = lpad(to_hex(2001),64,'0');
    -- Frozen slots add no retain, including a slot without a live candidate.
    INSERT INTO pi_memory_stage1_selections VALUES (1,lpad(to_hex(2001),64,'0')), (2,lpad(to_hex(501),64,'0'));
    UPDATE blobs SET ref_count = 0 WHERE hash = lpad(to_hex(2009),64,'0');
    UPDATE blobs SET ref_count = 2 WHERE hash = lpad(to_hex(2010),64,'0');
    DELETE FROM blobs WHERE hash = lpad(to_hex(2011),64,'0');
    INSERT INTO blobs (hash,ref_count) VALUES (repeat('e',64),7),(repeat('f',64),0);
  `);
  const beforeRuns = Array.from(
    await sql`SELECT to_jsonb(r) - 'legacy_conversation_history_hash' AS row FROM agent_runs r ORDER BY id`,
  );
  const beforeMemory = Array.from(
    await sql`SELECT to_jsonb(c) AS row FROM pi_memory_stage1_candidates c ORDER BY id`,
  );
  const beforeSelections = Array.from(
    await sql`SELECT to_jsonb(s) AS row FROM pi_memory_stage1_selections s ORDER BY id`,
  );
  const beforeMetadata = Array.from(
    await sql`SELECT to_jsonb(b) - 'ref_count' AS row FROM blobs b ORDER BY hash`,
  );
  process.chdir(directory);
  // A failed concurrent build leaves an invalid index behind. Replay must
  // replace it, rather than let IF NOT EXISTS silently accept unusable lookup.
  await assert.rejects(
    sql.unsafe(`CREATE UNIQUE INDEX CONCURRENTLY migration_1410_run_history_hash_idx
      ON agent_runs (legacy_conversation_history_hash)
      WHERE legacy_conversation_history_hash IS NOT NULL`),
    /could not create unique index/,
  );
  assert.equal(
    (
      await sql`SELECT indisvalid FROM pg_index
        WHERE indexrelid = 'migration_1410_run_history_hash_idx'::regclass`
    )[0]?.indisvalid,
    false,
  );
  // completed_at stores UTC without a zone. A migration connection's zone
  // must not shorten the Memory admission window at its ten-day boundary.
  await sql.unsafe("SET TIME ZONE 'Pacific/Kiritimati'");
  // A failure while decrementing a later batch must roll back that batch's
  // clears too, without undoing or reapplying the previously committed batch.
  await sql.unsafe(`ALTER TABLE blobs ADD CONSTRAINT reject_test_release
    CHECK (hash <> lpad(to_hex(1100),64,'0') OR ref_count > 0)`);
  await assert.rejects(applyPendingMigrations(sql), /reject_test_release/);
  assert.equal(
    (
      await sql`SELECT indisvalid AND NOT indisunique AS usable FROM pg_index
        WHERE indexrelid = 'migration_1410_run_history_hash_idx'::regclass`
    )[0]?.usable,
    true,
  );
  assert.equal(
    (
      await sql`SELECT count(*)::int AS count FROM agent_runs WHERE legacy_conversation_history_hash IS NULL`
    )[0]?.count,
    500,
  );
  assert.equal(
    (
      await sql`SELECT ref_count FROM blobs WHERE hash = lpad(to_hex(1001),64,'0')`
    )[0]?.ref_count,
    1,
  );
  assert.equal(
    (
      await sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`
    )[0]?.count,
    0,
  );
  await sql.unsafe("ALTER TABLE blobs DROP CONSTRAINT reject_test_release");
  await applyPendingMigrations(sql);
  assert.equal(
    (
      await sql`SELECT to_regclass('public.migration_1410_run_history_hash_idx') AS remaining_index`
    )[0]?.remaining_index,
    null,
  );
  assert.deepEqual(
    Array.from(
      await sql`SELECT to_jsonb(r) - 'legacy_conversation_history_hash' AS row FROM agent_runs r ORDER BY id`,
    ),
    beforeRuns,
  );
  assert.deepEqual(
    Array.from(
      await sql`SELECT to_jsonb(c) AS row FROM pi_memory_stage1_candidates c ORDER BY id`,
    ),
    beforeMemory,
  );
  assert.deepEqual(
    Array.from(
      await sql`SELECT to_jsonb(s) AS row FROM pi_memory_stage1_selections s ORDER BY id`,
    ),
    beforeSelections,
  );
  assert.deepEqual(
    Array.from(
      await sql`SELECT to_jsonb(b) - 'ref_count' AS row FROM blobs b ORDER BY hash`,
    ),
    beforeMetadata,
  );
  assert.deepEqual(
    Array.from(
      await sql`
    SELECT right(id::text,12) AS id, legacy_conversation_history_hash IS NULL AS cleared
    FROM agent_runs WHERE id >= '00000000-0000-0000-0001-000000000001' ORDER BY id
  `,
    ),
    [
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      false,
    ].map((cleared, index) => {
      return { id: String(index + 1).padStart(12, "0"), cleared };
    }),
  );
  assert.equal(
    (
      await sql`SELECT count(*)::int AS count FROM agent_runs WHERE legacy_conversation_history_hash IS NULL`
    )[0]?.count,
    604,
  );
  assert.equal(
    (
      await sql`SELECT ref_count FROM blobs WHERE hash = lpad(to_hex(2001),64,'0')`
    )[0]?.ref_count,
    2,
  );
  assert.equal(
    (
      await sql`SELECT sum(ref_count)::int AS refs FROM blobs WHERE hash BETWEEN lpad(to_hex(501),64,'0') AND lpad(to_hex(1100),64,'0')`
    )[0]?.refs,
    0,
  );
  assert.deepEqual(
    Array.from(
      await sql`SELECT ref_count FROM blobs WHERE hash IN (repeat('e',64),repeat('f',64)) ORDER BY hash`,
    ),
    [{ ref_count: 7 }, { ref_count: 0 }],
  );
  const committed = Array.from(
    await sql`SELECT hash,ref_count FROM blobs ORDER BY hash`,
  );
  // Simulate a committed last batch whose journal acknowledgement was lost.
  await sql`DELETE FROM drizzle.__drizzle_migrations`;
  await applyPendingMigrations(sql);
  assert.deepEqual(
    Array.from(await sql`SELECT hash,ref_count FROM blobs ORDER BY hash`),
    committed,
  );
  await applyPendingMigrations(sql);
  assert.deepEqual(
    Array.from(await sql`SELECT hash,ref_count FROM blobs ORDER BY hash`),
    committed,
  );
  console.log(
    "Legacy History retain release preserves Runs, Memory and metadata; skips unsafe accounting; and replays without duplicate decrements.",
  );
} finally {
  process.chdir(originalDirectory);
  await sql.end();
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
  } finally {
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
}
