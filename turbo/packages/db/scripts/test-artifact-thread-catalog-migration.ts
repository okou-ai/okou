import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import postgres from "postgres";
import { z } from "zod";
import { applyPendingMigrations } from "./migration-runner";
import { validatePermanentArtifactThreadCatalog } from "./test-artifact-thread-catalog-permanent";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(
  databaseUrl,
  "DATABASE_URL is required (disposable local PostgreSQL only)",
);
const admin = new Client({ connectionString: databaseUrl });
await admin.connect();
const databaseName = `artifact_catalog_${randomUUID().replaceAll("-", "")}`;
await admin.query(`CREATE DATABASE "${databaseName}"`);
const url = new URL(databaseUrl);
url.pathname = `/${databaseName}`;
const migrationClient = postgres(url.toString(), {
  max: 1,
  onnotice: () => {},
});
const client = new Client({ connectionString: url.toString() });
try {
  const journal = z
    .object({
      entries: z.array(z.object({ tag: z.string(), when: z.number() })),
    })
    .parse(
      JSON.parse(
        await readFile(
          new URL("../src/migrations/meta/_journal.json", import.meta.url),
          "utf8",
        ),
      ),
    );
  const entry = journal.entries.find((item) => {
    return item.tag.endsWith("_artifact_thread_catalog");
  });
  assert.ok(entry);
  await applyPendingMigrations(migrationClient, { beforeMillis: entry.when });
  await client.connect();
  await client.query(`
    INSERT INTO chat_threads (id, user_id, title) VALUES
      (md5('catalog-thread-a')::uuid, 'catalog-owner', 'Creating thread'),
      (md5('catalog-thread-b')::uuid, 'catalog-owner', 'Other thread');
    INSERT INTO run_uploaded_files
      (id, run_id, chat_thread_id, source, external_id, user_id, org_id, url, content_type, metadata)
    SELECT md5(label)::uuid, md5(run_label)::uuid,
      CASE WHEN label = 'direct' THEN md5('catalog-thread-a')::uuid ELSE NULL END,
      'test', label, 'catalog-owner', 'catalog-org',
      CASE WHEN label = 'empty-url' THEN '' ELSE 'https://example.test/' || label END,
      CASE WHEN label = 'avatar' THEN 'video/custom' WHEN label = 'override' THEN 'text/plain' ELSE NULL END,
      CASE label
        WHEN 'direct' THEN '{"aliasUrl":"https://example.test/direct-alias"}'::jsonb
        WHEN 'event' THEN '{"aliasUrl":""}'::jsonb
        WHEN 'ambiguous' THEN '{"aliasUrl":42}'::jsonb
        WHEN 'interrupt' THEN '{"aliasUrl":true}'::jsonb
        WHEN 'missing' THEN '{"aliasUrl":null}'::jsonb
        WHEN 'json-null' THEN '{"aliasUrl":null}'::jsonb
        WHEN 'avatar' THEN '{"generatedBy":"zero-joggai-avatar-video","aliasUrl":{}}'::jsonb
        WHEN 'extension' THEN '{"aliasUrl":["https://example.test/not-a-string"]}'::jsonb
        WHEN 'override' THEN '{"aliasUrl":"https://example.test/alias?x=1&name=原样"}'::jsonb
        WHEN 'empty-url' THEN '{"aliasUrl":" "}'::jsonb
        ELSE '{}'::jsonb
      END
    FROM (VALUES
      ('direct', 'ambiguous-run'), ('event', 'one-run'),
      ('ambiguous', 'ambiguous-run'), ('interrupt', 'interrupt-run'),
      ('missing', 'missing-run'), ('avatar', 'one-run'),
      ('extension', 'one-run'), ('override', 'one-run'), ('empty-url', 'one-run'),
      ('json-null', 'one-run'), ('absent-alias', 'one-run')
    ) fixture(label, run_label);
    INSERT INTO chat_events (id, chat_thread_id, run_id, event_type, seq_id)
    SELECT md5('catalog-event-' || seq)::uuid, md5(thread_label)::uuid,
      md5(run_label)::uuid, event_type, seq
    FROM (VALUES
      (1, 'catalog-thread-a', 'one-run', 'output.message'),
      (2, 'catalog-thread-a', 'one-run', 'output.error'),
      (3, 'catalog-thread-b', 'one-run', 'control.interrupt'),
      (4, 'catalog-thread-a', 'ambiguous-run', 'output.message'),
      (5, 'catalog-thread-b', 'ambiguous-run', 'output.message'),
      (6, 'catalog-thread-b', 'interrupt-run', 'control.interrupt')
    ) fixture(seq, thread_label, run_label, event_type);
    INSERT INTO shared_threads (id, user_id, org_id, source_chat_thread_id, title, messages)
    VALUES (md5('shared')::uuid, 'catalog-owner', 'catalog-org', md5('catalog-thread-a')::uuid, 'Snapshot', '[]');
    INSERT INTO artifacts (id, org_id, author_user_id, kind, entity_id, logical_key,
      projection_file_id, projection_created_at, title, thumbnail)
    SELECT md5('catalog-' || label)::uuid, 'catalog-org', 'catalog-owner',
      CASE WHEN label = 'avatar' THEN 'video' ELSE 'file' END,
      md5(label)::uuid,
      CASE WHEN label IN ('shared', 'missing-shared') THEN 'shared-thread:' || md5(label)::uuid::text ELSE 'file:' || label END,
      CASE WHEN label IN ('shared', 'missing-shared') THEN md5('direct')::uuid
        WHEN label = 'no-file' THEN NULL ELSE md5(label)::uuid END,
      '2026-10-19 00:00:00.123456',
      CASE WHEN label IN ('extension', 'override', 'empty-url') THEN label || '.MOV' ELSE label END,
      '{"url":"https://example.test/poster.png"}'::jsonb
    FROM unnest(ARRAY['direct','event','ambiguous','interrupt','missing','avatar',
      'extension','override','empty-url','json-null','absent-alias',
      'shared','missing-shared','no-file']) label;
    -- More than two batches, including UUID zero. All use proven direct origin.
    INSERT INTO artifacts (id, org_id, author_user_id, kind, entity_id, logical_key,
      projection_file_id, projection_created_at, title)
    SELECT CASE WHEN n = 0 THEN '00000000-0000-0000-0000-000000000000'::uuid ELSE md5('bulk-' || n)::uuid END,
      'catalog-org', 'catalog-owner', 'file', md5('bulk-entity-' || n)::uuid,
      'file:bulk-' || n, md5('direct')::uuid, now(), 'Bulk'
    FROM generate_series(0, 2005) n;
  `);
  const before = await client.query(
    `SELECT id, (to_jsonb(a))::text AS fact FROM artifacts a ORDER BY id`,
  );
  // An interrupted expansion or current writer may already have populated aliases.
  // The IF NOT EXISTS expansion and guarded assignment must preserve those bytes.
  await client.query(`
    ALTER TABLE artifacts ADD COLUMN alias_url text;
    UPDATE artifacts SET alias_url = 'https://example.test/already-written?x=1&y=2'
    WHERE title = 'missing';
  `);
  // Force a real post-DDL/backfill journal failure. All committed statements
  // must survive and be safe when the runner restarts the migration from NULL.
  await client.query(
    `ALTER TABLE drizzle.__drizzle_migrations ADD CONSTRAINT artifact_test_journal_failure CHECK (created_at <> ${entry.when}) NOT VALID`,
  );
  await assert.rejects(
    applyPendingMigrations(migrationClient, { beforeMillis: entry.when + 1 }),
    { code: "23514" },
  );
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations WHERE created_at = $1",
        [entry.when],
      )
    ).rows[0]?.count,
    0,
  );
  const afterFailure = await client.query(
    "SELECT * FROM artifacts ORDER BY id",
  );
  await client.query(
    "ALTER TABLE drizzle.__drizzle_migrations DROP CONSTRAINT artifact_test_journal_failure",
  );
  await applyPendingMigrations(migrationClient, {
    beforeMillis: entry.when + 1,
  });
  const afterRetry = await client.query("SELECT * FROM artifacts ORDER BY id");
  assert.deepEqual(afterRetry.rows, afterFailure.rows);
  assert.deepEqual(
    (
      await client.query(
        `SELECT id, (to_jsonb(a) - ARRAY['chat_thread_id','display_kind','source_url','alias_url','video_source_url'])::text AS fact FROM artifacts a ORDER BY id`,
      )
    ).rows,
    before.rows,
  );
  const rows = await client.query<{
    label: string;
    thread_id: string | null;
    display_kind: string | null;
    source_url: string | null;
    alias_url: string | null;
    video_source_url: string | null;
  }>(`SELECT title AS label, chat_thread_id AS thread_id, display_kind, source_url, alias_url, video_source_url
      FROM artifacts WHERE logical_key NOT LIKE 'file:bulk-%' ORDER BY title`);
  const creatingThread = (
    await client.query<{ id: string }>(
      "SELECT md5('catalog-thread-a')::uuid AS id",
    )
  ).rows[0]?.id;
  assert.ok(creatingThread);
  for (const row of rows.rows) {
    const label = row.label.replace(/\.MOV$/, "");
    assert.equal(
      row.thread_id,
      [
        "direct",
        "event",
        "avatar",
        "extension",
        "override",
        "empty-url",
        "json-null",
        "absent-alias",
        "shared",
      ].includes(label)
        ? creatingThread
        : null,
      label,
    );
    assert.equal(
      row.display_kind,
      label === "avatar"
        ? "avatar"
        : label.includes("shared")
          ? "shared-thread"
          : "file",
      label,
    );
    assert.equal(
      row.source_url,
      ["shared", "missing-shared", "no-file"].includes(label)
        ? null
        : label === "empty-url"
          ? ""
          : `https://example.test/${label}`,
      label,
    );
    assert.equal(
      row.alias_url,
      label === "direct"
        ? "https://example.test/direct-alias"
        : label === "override"
          ? "https://example.test/alias?x=1&name=原样"
          : label === "empty-url"
            ? " "
            : label === "missing"
              ? "https://example.test/already-written?x=1&y=2"
              : null,
      label,
    );
    assert.equal(
      row.video_source_url,
      ["avatar", "extension"].includes(label)
        ? `https://example.test/${label}`
        : null,
      label,
    );
  }
  const bulk = await client.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM artifacts WHERE logical_key LIKE 'file:bulk-%' AND chat_thread_id = $1 AND display_kind = 'file' AND alias_url = $2",
    [creatingThread, "https://example.test/direct-alias"],
  );
  assert.equal(bulk.rows[0]?.count, 2006);
  // FK deletion must preserve every global row and all original display facts.
  const globalBefore = await client.query(
    "SELECT id, (to_jsonb(a) - 'chat_thread_id')::text AS fact FROM artifacts a ORDER BY id",
  );
  await client.query("DELETE FROM chat_threads WHERE id = $1", [
    creatingThread,
  ]);
  assert.deepEqual(
    (
      await client.query(
        "SELECT id, (to_jsonb(a) - 'chat_thread_id')::text AS fact FROM artifacts a ORDER BY id",
      )
    ).rows,
    globalBefore.rows,
  );
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::int AS count FROM artifacts WHERE chat_thread_id IS NOT NULL",
      )
    ).rows[0]?.count,
    0,
  );
  await applyPendingMigrations(migrationClient, {
    beforeMillis: entry.when + 1,
  });
  assert.deepEqual(
    (
      await client.query(
        "SELECT id, (to_jsonb(a) - 'chat_thread_id')::text AS fact FROM artifacts a ORDER BY id",
      )
    ).rows,
    globalBefore.rows,
  );
  await validatePermanentArtifactThreadCatalog(url.toString());
  console.log(
    "Artifact migration replay, committed retry, conservative origins, batched alias/display backfill and byte-stable deletion preservation passed",
  );
} finally {
  await client.end();
  await migrationClient.end();
  await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await admin.end();
}
