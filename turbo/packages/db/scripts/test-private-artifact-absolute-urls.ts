import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const client = new Client({ connectionString: databaseUrl });
await client.connect();
const schema = `private_artifact_urls_${randomUUID().replaceAll("-", "")}`;
const APP_ORIGIN = "https://app.okou.ai";
const relativeVideo = "/artifacts/abc123def4.mp4";
const relativePoster = "/artifacts/poster1234.jpg";
const absoluteVideo = `${APP_ORIGIN}${relativeVideo}`;
const absolutePoster = `${APP_ORIGIN}${relativePoster}`;

async function snapshot(): Promise<readonly unknown[]> {
  const tables = [
    "run_uploaded_files",
    "private_hosted_deployments",
    "hosted_deployments",
    "artifacts",
    "built_in_generation_jobs",
    "socialkit_download_jobs",
    "user_artifact_favorites",
    "image_artifact_edit_snapshots",
  ] as const;
  const result: unknown[] = [];
  for (const table of tables) {
    const rows = await client.query(
      `SELECT to_jsonb(record)::text AS value FROM ${table} AS record ORDER BY to_jsonb(record)::text`,
    );
    result.push(rows.rows);
  }
  return result;
}

try {
  await client.query("BEGIN");
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET LOCAL search_path TO "${schema}"`);
  await client.query(`
    CREATE TABLE run_uploaded_files (
      id text PRIMARY KEY,
      url text,
      preview_image_url text,
      updated_at timestamp NOT NULL DEFAULT '2026-01-01'
    );
    CREATE TABLE private_hosted_deployments (
      id text PRIMARY KEY,
      artifact_url text NOT NULL,
      url text NOT NULL,
      updated_at timestamp NOT NULL DEFAULT '2026-01-01'
    );
    CREATE TABLE hosted_deployments (
      id text PRIMARY KEY,
      artifact_url text,
      url text NOT NULL,
      updated_at timestamp NOT NULL DEFAULT '2026-01-01'
    );
    CREATE TABLE artifacts (
      id text PRIMARY KEY,
      logical_key text NOT NULL,
      thumbnail jsonb,
      updated_at timestamp NOT NULL DEFAULT '2026-01-01',
      UNIQUE (logical_key)
    );
    CREATE TABLE built_in_generation_jobs (
      id text PRIMARY KEY,
      result jsonb,
      updated_at timestamp NOT NULL DEFAULT '2026-01-01'
    );
    CREATE TABLE socialkit_download_jobs (
      id text PRIMARY KEY,
      artifact jsonb,
      updated_at timestamp NOT NULL DEFAULT '2026-01-01'
    );
    CREATE TABLE user_artifact_favorites (
      org_id text NOT NULL,
      user_id text NOT NULL,
      artifact_url text NOT NULL,
      PRIMARY KEY (org_id, user_id, artifact_url)
    );
    CREATE TABLE image_artifact_edit_snapshots (
      id text PRIMARY KEY,
      artifact_url text NOT NULL,
      snapshot jsonb NOT NULL,
      UNIQUE (artifact_url)
    );
  `);
  await client.query(
    `
      INSERT INTO run_uploaded_files (id, url, preview_image_url) VALUES
        ('relative', $1, $2),
        ('absolute', $3, $4),
        ('public', 'https://a.okou.io/public.mp4', 'https://cdn.okou.io/public.jpg'),
        ('external', 'https://example.com/video.mp4', NULL)
    `,
    [relativeVideo, relativePoster, absoluteVideo, absolutePoster],
  );
  await client.query(`
    INSERT INTO private_hosted_deployments (id, artifact_url, url) VALUES
      ('relative', '/artifacts/site123456.html', '/artifacts/site123456.html'),
      ('absolute', 'https://app.okou.ai/artifacts/site654321.html', 'https://app.okou.ai/artifacts/site654321.html');
    INSERT INTO hosted_deployments (id, artifact_url, url) VALUES
      ('relative', '/artifacts/legacy1234.html', '/artifacts/legacy1234.html'),
      ('public', 'https://dpl-public.okou.app', 'https://public.okou.app');
    INSERT INTO artifacts (id, logical_key, thumbnail) VALUES
      ('relative', 'file:/artifacts/abc123def4.mp4', '{"url":"/artifacts/poster1234.jpg","width":640}'),
      ('hosted', 'site:site-id', '{"url":"/artifacts/siteposter.jpg"}'),
      ('public', 'file:https://a.okou.io/public.mp4', '{"url":"https://cdn.okou.io/public.jpg"}');
    INSERT INTO built_in_generation_jobs (id, result) VALUES
      ('relative', '{"url":"/artifacts/abc123def4.mp4","model":"test"}'),
      ('public', '{"url":"https://a.okou.io/public.mp4","model":"test"}');
    INSERT INTO socialkit_download_jobs (id, artifact) VALUES
      ('relative', '{"url":"/artifacts/abc123def4.mp4","sizeBytes":10}'),
      ('public', '{"url":"https://a.okou.io/public.mp4","sizeBytes":10}');
    INSERT INTO user_artifact_favorites (org_id, user_id, artifact_url) VALUES
      ('org', 'user-relative', '/artifacts/abc123def4.mp4'),
      ('org', 'user-public', 'https://a.okou.io/public.mp4');
    INSERT INTO image_artifact_edit_snapshots (id, artifact_url, snapshot) VALUES
      (
        'relative',
        '/artifacts/image12345.png',
        '{"version":1,"items":[{"url":"/artifacts/layer12345.png","x":0,"y":0,"zIndex":1},{"url":"https://example.com/layer.png","x":1,"y":1,"zIndex":2}]}'
      ),
      (
        'public',
        'https://a.okou.io/public.png',
        '{"version":1,"items":[{"url":"https://a.okou.io/public.png","x":0,"y":0,"zIndex":1}]}'
      );
  `);

  const migration = await readFile(
    new URL(
      "../src/migrations/1167_private_artifact_absolute_urls.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await client.query(migration);

  assert.deepEqual(
    (
      await client.query(
        "SELECT id, url, preview_image_url FROM run_uploaded_files ORDER BY id",
      )
    ).rows,
    [
      { id: "absolute", url: absoluteVideo, preview_image_url: absolutePoster },
      {
        id: "external",
        url: "https://example.com/video.mp4",
        preview_image_url: null,
      },
      {
        id: "public",
        url: "https://a.okou.io/public.mp4",
        preview_image_url: "https://cdn.okou.io/public.jpg",
      },
      { id: "relative", url: absoluteVideo, preview_image_url: absolutePoster },
    ],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT id, artifact_url, url FROM private_hosted_deployments ORDER BY id",
      )
    ).rows,
    [
      {
        id: "absolute",
        artifact_url: "https://app.okou.ai/artifacts/site654321.html",
        url: "https://app.okou.ai/artifacts/site654321.html",
      },
      {
        id: "relative",
        artifact_url: "https://app.okou.ai/artifacts/site123456.html",
        url: "https://app.okou.ai/artifacts/site123456.html",
      },
    ],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT id, artifact_url, url FROM hosted_deployments ORDER BY id",
      )
    ).rows,
    [
      {
        id: "public",
        artifact_url: "https://dpl-public.okou.app",
        url: "https://public.okou.app",
      },
      {
        id: "relative",
        artifact_url: "https://app.okou.ai/artifacts/legacy1234.html",
        url: "https://app.okou.ai/artifacts/legacy1234.html",
      },
    ],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT id, logical_key, thumbnail FROM artifacts ORDER BY id",
      )
    ).rows,
    [
      {
        id: "hosted",
        logical_key: "site:site-id",
        thumbnail: { url: "https://app.okou.ai/artifacts/siteposter.jpg" },
      },
      {
        id: "public",
        logical_key: "file:https://a.okou.io/public.mp4",
        thumbnail: { url: "https://cdn.okou.io/public.jpg" },
      },
      {
        id: "relative",
        logical_key: `file:${absoluteVideo}`,
        thumbnail: { url: absolutePoster, width: 640 },
      },
    ],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT id, result FROM built_in_generation_jobs ORDER BY id",
      )
    ).rows,
    [
      {
        id: "public",
        result: { model: "test", url: "https://a.okou.io/public.mp4" },
      },
      { id: "relative", result: { model: "test", url: absoluteVideo } },
    ],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT id, artifact FROM socialkit_download_jobs ORDER BY id",
      )
    ).rows,
    [
      {
        id: "public",
        artifact: { sizeBytes: 10, url: "https://a.okou.io/public.mp4" },
      },
      { id: "relative", artifact: { sizeBytes: 10, url: absoluteVideo } },
    ],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT user_id, artifact_url FROM user_artifact_favorites ORDER BY user_id",
      )
    ).rows,
    [
      { user_id: "user-public", artifact_url: "https://a.okou.io/public.mp4" },
      { user_id: "user-relative", artifact_url: absoluteVideo },
    ],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT id, artifact_url, snapshot FROM image_artifact_edit_snapshots ORDER BY id",
      )
    ).rows,
    [
      {
        id: "public",
        artifact_url: "https://a.okou.io/public.png",
        snapshot: {
          version: 1,
          items: [
            {
              url: "https://a.okou.io/public.png",
              x: 0,
              y: 0,
              zIndex: 1,
            },
          ],
        },
      },
      {
        id: "relative",
        artifact_url: "https://app.okou.ai/artifacts/image12345.png",
        snapshot: {
          version: 1,
          items: [
            {
              url: "https://app.okou.ai/artifacts/layer12345.png",
              x: 0,
              y: 0,
              zIndex: 1,
            },
            {
              url: "https://example.com/layer.png",
              x: 1,
              y: 1,
              zIndex: 2,
            },
          ],
        },
      },
    ],
  );

  const once = await snapshot();
  await client.query(migration);
  assert.deepEqual(await snapshot(), once);
  console.log("Private artifact absolute URL migration checks passed");
} finally {
  await client.query("ROLLBACK");
  await client.end();
}
