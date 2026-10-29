import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { array, number, object, string } from "zod";
import { applyPendingMigrations } from "./migration-runner";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const databaseName = `upload_artifact_threads_${randomUUID().replaceAll("-", "")}`;
const admin = postgres(databaseUrl, { max: 1, onnotice: () => {} });
const url = new URL(databaseUrl);
url.pathname = `/${databaseName}`;
const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
const owner = `upload-owner-${randomUUID()}`;
const org = `upload-org-${randomUUID()}`;
const agentId = randomUUID();

type Scenario =
  | "repair"
  | "deleted-origin"
  | "already-associated"
  | "runless-origin"
  | "input"
  | "foreign-owner"
  | "legacy-storage"
  | "ambiguous-origin";

async function seedUpload(scenario: Scenario) {
  const threadId = randomUUID();
  const laterThreadId = randomUUID();
  const runId = randomUUID();
  const laterRunId = randomUUID();
  const ownershipId = randomUUID();
  const firstFileId = randomUUID();
  const projectionId = randomUUID();
  const artifactId = randomUUID();
  const sourceUrl = `https://app.okou.ai/artifacts/${ownershipId}.mp4`;
  const storageKey = `private-artifacts/${ownershipId}/demo.mp4`;
  const threadOwner = scenario === "foreign-owner" ? "another-owner" : owner;
  await sql`INSERT INTO chat_threads (id, user_id)
    VALUES (${threadId}, ${threadOwner}), (${laterThreadId}, ${owner})`;
  await sql`INSERT INTO agent_runs
      (id, agent_id, user_id, org_id, chat_thread_id, status, prompt,
       trigger_source, autonomy_budget, created_at, completed_at)
    VALUES (${runId}, ${agentId}, ${owner}, ${org}, ${threadId},
      'completed', '', 'web', 0,
      ${scenario === "runless-origin" ? "2026-10-21" : "2026-10-19"}::timestamp,
      timestamp '2026-10-22'),
      (${laterRunId}, ${agentId}, ${owner}, ${org}, ${laterThreadId},
      'completed', '', 'web', 0,
      ${scenario === "ambiguous-origin" ? "2026-10-19" : "2026-10-23"}::timestamp,
      timestamp '2026-10-24')`;
  await sql`INSERT INTO run_uploaded_files
      (id, source, external_id, user_id, org_id, url, storage_key, metadata,
       classification, created_at)
    VALUES (${ownershipId}, 'web', ${ownershipId}, ${owner}, ${org},
      ${sourceUrl}, ${storageKey},
      ${sql.json({
        ...(scenario === "legacy-storage"
          ? {}
          : { storage: "private-artifact-v1" }),
        purpose: "artifact",
      })}, ${scenario === "input" ? "input" : null}, timestamp '2026-10-20')`;
  await sql`INSERT INTO run_uploaded_files
      (id, run_id, chat_thread_id, source, external_id, user_id, org_id, url,
       metadata, created_at)
    VALUES (${firstFileId}, ${runId}, ${threadId}, 'web', ${ownershipId},
      ${owner}, ${org}, ${sourceUrl}, ${sql.json({ s3Key: storageKey })},
      timestamp '2026-10-21'),
      (${projectionId}, ${laterRunId}, ${laterThreadId}, 'web', ${ownershipId},
      ${owner}, ${org}, ${sourceUrl}, ${sql.json({ s3Key: storageKey })},
      ${scenario === "ambiguous-origin" ? "2026-10-21" : "2026-10-23"}::timestamp)`;
  await sql`INSERT INTO artifacts
      (id, org_id, author_user_id, kind, entity_id, logical_key,
       projection_file_id, projection_created_at, title, created_at,
       chat_thread_id, source_url)
    VALUES (${artifactId}, ${org}, ${owner}, 'file', ${projectionId},
      ${`file:${sourceUrl}`}, ${projectionId},
      ${scenario === "ambiguous-origin" ? "2026-10-21" : "2026-10-23"}::timestamp,
      'demo.mp4', timestamp '2026-10-20',
      ${scenario === "already-associated" ? threadId : null}, ${sourceUrl})`;
  if (scenario === "deleted-origin") {
    await sql`DELETE FROM chat_threads WHERE id = ${threadId}`;
  }
  return {
    id: artifactId,
    expectedThreadId:
      scenario === "repair" || scenario === "already-associated"
        ? threadId
        : null,
  };
}

try {
  const journal = object({
    entries: array(object({ tag: string(), when: number() })),
  }).parse(
    JSON.parse(
      await readFile(
        new URL("../src/migrations/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const entry = journal.entries.find(({ tag }) => {
    return tag.endsWith("_repair_web_upload_artifact_threads");
  });
  assert.ok(entry);
  const source = await readFile(
    new URL(`../src/migrations/${entry.tag}.sql`, import.meta.url),
    "utf8",
  );
  const batch = source.split("--> statement-breakpoint").find((statement) => {
    return statement.includes("-- okou:batch-by-uuid");
  });
  assert.ok(batch);
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  await applyPendingMigrations(sql, { beforeMillis: entry.when });
  await sql`INSERT INTO agents (id, org_id, owner, name)
    VALUES (${agentId}, ${org}, ${owner}, 'upload-repair')`;
  // A full batch of unknown origins must not prevent a later eligible repair.
  await sql`INSERT INTO artifacts
      (id, org_id, author_user_id, kind, entity_id, logical_key,
       projection_created_at, title)
    SELECT ('00000000-0000-4000-8000-' || lpad(to_hex(i), 12, '0'))::uuid,
      ${org}, ${owner}, 'file', gen_random_uuid(), 'file:unknown-' || i,
      now(), 'Unattributed output' FROM generate_series(1, 1000) i`;
  const scenarios = [
    "repair",
    "deleted-origin",
    "already-associated",
    "runless-origin",
    "input",
    "foreign-owner",
    "legacy-storage",
    "ambiguous-origin",
  ] as const;
  const expected = [];
  for (const scenario of scenarios) {
    expected.push(await seedUpload(scenario));
  }
  const before = await sql`SELECT id, source_url, entity_id, projection_file_id,
    title, created_at, updated_at FROM artifacts ORDER BY id`;
  await applyPendingMigrations(sql);
  for (const { id, expectedThreadId } of expected) {
    const [artifact] =
      await sql`SELECT chat_thread_id FROM artifacts WHERE id = ${id}`;
    assert.equal(artifact?.chat_thread_id, expectedThreadId);
  }
  assert.deepEqual(
    await sql`SELECT id, source_url, entity_id, projection_file_id,
      title, created_at, updated_at FROM artifacts ORDER BY id`,
    before,
    "repair preserves catalog identity, projection, delivery URL and timestamps",
  );
  const repaired =
    await sql`SELECT id, chat_thread_id, xmin::text FROM artifacts ORDER BY id`;
  // A drain-time replay of the reviewed batch must not physically rewrite rows.
  let cursor: string | null = null;
  do {
    const [page] = object({ next_cursor: string().nullable() })
      .array()
      .parse(await sql.unsafe(batch, [cursor]));
    assert.ok(page);
    cursor = page.next_cursor;
  } while (cursor !== null);
  assert.deepEqual(
    await sql`SELECT id, chat_thread_id, xmin::text FROM artifacts ORDER BY id`,
    repaired,
  );
  console.log(
    "Upload artifact thread repair: 8 scenarios, batch gaps and replay passed",
  );
} finally {
  await sql.end();
  await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
  await admin.end();
}
