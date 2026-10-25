#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

// Run against a migrated disposable database. Temporary copies keep all fixture
// writes isolated from its public tables while exercising the actual migration.
const client = new Client({ connectionString: process.env.DATABASE_URL });
const migration = await readFile(
  new URL(
    "../src/migrations/1461_migrate_presentation_templates_to_user_templates.sql",
    import.meta.url,
  ),
  "utf8",
);
const tables = [
  "presentation_templates",
  "user_templates",
  "storages",
  "storage_versions",
] as const;

async function snapshot() {
  const entries: (readonly [string, readonly Record<string, unknown>[]])[] = [];
  for (const table of tables) {
    const result = await client.query<{ row: Record<string, unknown> }>(
      `SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY id`,
    );
    entries.push([
      table,
      result.rows.map(({ row }) => {
        return row;
      }),
    ]);
  }
  return Object.fromEntries(entries);
}

async function seed() {
  await client.query(`
    TRUNCATE presentation_templates, user_templates, storages, storage_versions;
    INSERT INTO presentation_templates (
      id, org_id, owner_user_id, visibility, title, source_storage_key,
      source_filename, page_keys, created_by, updated_by, created_at, updated_at
    ) VALUES
      ('00000000-0000-4000-8000-000000000001', 'org-a', 'owner-a', 'private',
       'Private deck', 'private/source-a', 'deck-a.pptx',
       ARRAY['private/cover-a', 'private/page-2-a'],
       'creator-a', 'editor-a', '2026-09-01 01:02:03', '2026-10-01 04:05:06'),
      ('00000000-0000-4000-8000-000000000002', 'org-b', 'owner-b', 'public',
       'Shared deck', 'private/source-b', 'deck-b.pdf',
       ARRAY['private/cover-b'],
       'creator-b', 'editor-b', '2026-09-02 01:02:03', '2026-10-02 04:05:06');
    INSERT INTO user_templates (
      id, org_id, owner_user_id, title, source_storage_key,
      source_filename, manifest, created_by, updated_by
    ) VALUES (
      '00000000-0000-4000-8000-000000000003', 'org-a', 'owner-a',
      'Existing document', 'private/document', 'document.docx',
      '{"kind":"document","pageCount":2}', 'owner-a', 'owner-a'
    );
    INSERT INTO storages (org_id, user_id, name, s3_prefix, created_at, updated_at)
    SELECT org_id, '__org__', 'presentation-template@' || id::text,
      'original/prefix/' || id::text, created_at, updated_at
    FROM presentation_templates;
    INSERT INTO storage_versions (
      id, storage_id, s3_key, size, archive_size, file_count, created_by
    ) SELECT replace(id::text, '-', ''), id, s3_prefix || '/original-version',
        1234, 567, 2, '__system__'
      FROM storages;
    UPDATE storages SET head_version_id = replace(id::text, '-', ''),
      size = 1234, file_count = 2;
    -- Same name in another tenant or user scope must remain untouched.
    INSERT INTO storages (org_id, user_id, name, s3_prefix)
    SELECT 'org-unrelated', '__org__', name, 'unrelated/prefix'
      FROM storages WHERE org_id = 'org-a';
    INSERT INTO storages (org_id, user_id, name, s3_prefix)
    SELECT org_id, 'another-user', name, 'user/prefix'
      FROM storages WHERE org_id = 'org-a';
  `);
}

try {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  await client.connect();
  for (const table of tables) {
    await client.query(
      `CREATE TEMP TABLE "${table}" (LIKE public."${table}" INCLUDING ALL)`,
    );
  }

  await seed();
  const before = await snapshot();
  await client.query(migration);
  const after = await snapshot();
  assert.deepEqual(after.presentation_templates, []);
  assert.deepEqual(after.user_templates, [
    ...before.presentation_templates!.map((row) => {
      const {
        page_keys: pageKeys,
        aspect_ratio: aspectRatio,
        ...retained
      } = row;
      assert.equal(aspectRatio, null);
      return {
        ...retained,
        visibility: row.visibility === "public" ? "organization" : "private",
        manifest: { kind: "presentation", pageKeys },
      };
    }),
    ...before.user_templates!,
  ]);
  assert.deepEqual(after.storage_versions, before.storage_versions);
  assert.deepEqual(
    after.storages,
    before.storages!.map((row) => {
      return row.user_id === "__org__" && row.org_id !== "org-unrelated"
        ? {
            ...row,
            name: String(row.name).replace(
              "presentation-template@",
              "user-template@",
            ),
          }
        : row;
    }),
  );
  await client.query(migration);
  assert.deepEqual(await snapshot(), after);
  console.log(
    "Template metadata, permissions, package identity and replay preserved",
  );

  const failures = [
    {
      name: "missing package",
      sql: `UPDATE storages SET head_version_id = NULL WHERE org_id = 'org-b';
        DELETE FROM storage_versions WHERE storage_id IN
        (SELECT id FROM storages WHERE org_id = 'org-b');
        DELETE FROM storages WHERE org_id = 'org-b'`,
      error: /Expected one committed guidance package/,
    },
    {
      name: "unfinished package",
      sql: "UPDATE storages SET head_version_id = NULL WHERE org_id = 'org-b'",
      error: /Expected one committed guidance package/,
    },
    {
      name: "HEAD owned by a different storage",
      sql: `UPDATE storages SET head_version_id = (
        SELECT head_version_id FROM storages WHERE org_id = 'org-a'
          AND user_id = '__org__'
      ) WHERE org_id = 'org-b'`,
      error: /Expected one committed guidance package/,
    },
    {
      name: "destination template collision",
      sql: `UPDATE user_templates SET id =
        '00000000-0000-4000-8000-000000000002'`,
      error: /duplicate key value violates unique constraint/,
    },
    {
      name: "destination volume collision",
      sql: `INSERT INTO storages (org_id, user_id, name, s3_prefix)
        VALUES ('org-b', '__org__',
          'user-template@00000000-0000-4000-8000-000000000002', 'destination')`,
      error: /duplicate key value violates unique constraint/,
    },
  ];
  for (const failure of failures) {
    await seed();
    await client.query(failure.sql);
    const unchanged = await snapshot();
    await assert.rejects(client.query(migration), failure.error);
    assert.deepEqual(await snapshot(), unchanged);
    console.log(`Atomic rollback verified: ${failure.name}`);
  }
} finally {
  await client.end();
}
