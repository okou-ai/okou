import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { artifacts } from "../src/schema/artifact";

/** Current catalog contract on both replayed and freshly generated schemas. */
export async function validatePermanentArtifactThreadCatalog(
  databaseUrl: string,
) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const db = drizzle(client);
  const threadId = randomUUID();
  const ids = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ] as const;
  const userId = `artifact-owner-${threadId}`;
  try {
    await client.query(
      "INSERT INTO chat_threads (id, user_id) VALUES ($1, $2)",
      [threadId, userId],
    );
    const values = {
      orgId: `artifact-org-${threadId}`,
      authorUserId: userId,
      kind: "video" as const,
      entityId: randomUUID(),
      logicalKey: `file:${threadId}`,
      projectionCreatedAt: new Date("2026-10-19T00:00:00Z"),
      title: "Avatar without a video extension",
      thumbnail: { url: "https://example.test/poster.png" },
      chatThreadId: threadId,
      displayKind: "avatar" as const,
      sourceUrl: "https://example.test/unusual-extension.bin",
      aliasUrl: "https://example.test/alias?x=1&name=原样%20unchanged",
      videoSourceUrl: "https://example.test/unusual-extension.bin",
    };
    const [created] = await db
      .insert(artifacts)
      .values({ id: ids[0], ...values })
      .returning();
    assert.ok(created);
    assert.equal(created.displayKind, "avatar");
    assert.equal(created.aliasUrl, values.aliasUrl);
    // Frozen outgoing-writer column list, executed after schema/backfill replay.
    // These legitimate NULL summaries are a permanent global-only contract.
    const oldKinds = [
      "file",
      "hosted-site",
      "image",
      "video",
      "presentation",
      "shared-thread",
    ] as const;
    for (const [offset, kind] of oldKinds.entries()) {
      await client.query(
        `INSERT INTO artifacts (id, org_id, author_user_id, kind, entity_id,
         logical_key, projection_created_at, title)
         VALUES ($1, $2, $3, $4, $5, $6, now(), 'Old API output')`,
        [
          ids[offset + 1],
          values.orgId,
          userId,
          kind === "shared-thread" ? "file" : kind,
          randomUUID(),
          kind === "shared-thread"
            ? `shared-thread:${threadId}`
            : `${kind}:old-${threadId}`,
        ],
      );
    }
    // Real SQL reads at the owning DB boundary: filtering happens before
    // summary conversion and must not discard a NULL display_kind row.
    // No projection/source join can invent avatar metadata or a thread.
    for (const [offset, kind] of oldKinds.entries()) {
      const category = await client.query<{ id: string; catalog_kind: string }>(
        `SELECT id, COALESCE(display_kind,
           CASE WHEN kind = 'file' AND logical_key LIKE 'shared-thread:%'
             THEN 'shared-thread' ELSE kind END) AS catalog_kind
         FROM artifacts
         WHERE org_id = $1 AND author_user_id = $2
           AND COALESCE(display_kind,
             CASE WHEN kind = 'file' AND logical_key LIKE 'shared-thread:%'
               THEN 'shared-thread' ELSE kind END) = $3`,
        [values.orgId, userId, kind],
      );
      assert.deepEqual(category.rows, [
        { id: ids[offset + 1], catalog_kind: kind },
      ]);
    }
    const avatars = await client.query<{ id: string }>(
      `SELECT id FROM artifacts
       WHERE org_id = $1 AND author_user_id = $2
         AND COALESCE(display_kind,
           CASE WHEN kind = 'file' AND logical_key LIKE 'shared-thread:%'
             THEN 'shared-thread' ELSE kind END) = 'avatar'`,
      [values.orgId, userId],
    );
    assert.deepEqual(avatars.rows, [{ id: ids[0] }]);
    const oldSummaries = await client.query(
      `SELECT id, chat_thread_id, display_kind, source_url, alias_url,
         video_source_url FROM artifacts WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [ids.slice(1)],
    );
    assert.deepEqual(
      oldSummaries.rows,
      ids
        .slice(1)
        .sort()
        .map((id) => {
          return {
            id,
            chat_thread_id: null,
            display_kind: null,
            source_url: null,
            alias_url: null,
            video_source_url: null,
          };
        }),
    );
    const [old] = await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, ids[1]));
    assert.ok(old);
    assert.equal(old.chatThreadId, null);
    assert.equal(old.displayKind, null);
    assert.equal(old.sourceUrl, null);
    assert.equal(old.aliasUrl, null);
    assert.equal(old.videoSourceUrl, null);
    const constraints = await client.query<{
      validated: boolean;
      deletion: string;
    }>(
      `SELECT convalidated AS validated, confdeltype AS deletion FROM pg_constraint
       WHERE conrelid = 'artifacts'::regclass
         AND conname = 'artifacts_chat_thread_id_chat_threads_id_fk'`,
    );
    assert.deepEqual(constraints.rows, [{ validated: true, deletion: "n" }]);
    const index = await client.query<{ valid: boolean; definition: string }>(
      `SELECT i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS definition
       FROM pg_index i WHERE i.indexrelid = 'artifacts_thread_author_created_idx'::regclass`,
    );
    assert.equal(index.rows[0]?.valid, true);
    assert.match(
      index.rows[0]?.definition ?? "",
      /\(chat_thread_id, org_id, author_user_id, created_at DESC NULLS LAST, id DESC NULLS LAST\)/,
    );
    assert.match(
      index.rows[0]?.definition ?? "",
      /WHERE \(chat_thread_id IS NOT NULL\)/,
    );
    await assert.rejects(
      client.query("UPDATE artifacts SET chat_thread_id = $1 WHERE id = $2", [
        randomUUID(),
        ids[0],
      ]),
      {
        code: "23503",
        constraint: "artifacts_chat_thread_id_chat_threads_id_fk",
      },
    );
    const beforeDeletion = await client.query(
      `SELECT id, (to_jsonb(a) - 'chat_thread_id')::text AS fact
       FROM artifacts a WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [ids],
    );
    await client.query("DELETE FROM chat_threads WHERE id = $1", [threadId]);
    assert.deepEqual(
      (
        await client.query(
          `SELECT id, (to_jsonb(a) - 'chat_thread_id')::text AS fact
           FROM artifacts a WHERE id = ANY($1::uuid[]) ORDER BY id`,
          [ids],
        )
      ).rows,
      beforeDeletion.rows,
    );
    const [retained] = await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, ids[0]));
    assert.deepEqual(retained, { ...created, chatThreadId: null });
    assert.deepEqual(
      await db.select().from(artifacts).where(eq(artifacts.id, ids[1])),
      [old],
    );
    console.log(
      "Artifact catalog retains nullable global categories and display fields after thread deletion",
    );
  } finally {
    try {
      await client.query("DELETE FROM artifacts WHERE id = ANY($1::uuid[])", [
        ids,
      ]);
      await client.query("DELETE FROM chat_threads WHERE id = $1", [threadId]);
    } finally {
      await client.end();
    }
  }
}
