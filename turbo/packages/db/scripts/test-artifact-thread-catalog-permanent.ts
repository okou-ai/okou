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
  const ids = [randomUUID(), randomUUID()] as const;
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
    // The old API's explicit column list must remain legal after expansion.
    await client.query(
      `INSERT INTO artifacts (id, org_id, author_user_id, kind, entity_id,
       logical_key, projection_created_at, title)
       VALUES ($1, $2, $3, 'file', $4, $5, now(), 'Old API output')`,
      [ids[1], values.orgId, userId, randomUUID(), `file:old-${threadId}`],
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
      "Artifact catalog retains global rows and display fields after thread deletion",
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
