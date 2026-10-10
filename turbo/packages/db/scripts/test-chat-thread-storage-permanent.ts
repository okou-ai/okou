import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import { schema } from "../src/index";
import { chatThreads } from "../src/runtime/chat-thread";

/** Current thread SQL contract, exercised on replayed and freshly generated schemas. */
export async function validatePermanentChatThreadStorage(databaseUrl: string) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const db = drizzle(client, { schema });
  const id = randomUUID();
  const values = { id, userId: `thread-owner-${id}`, title: "Initial title" };
  try {
    const [created] = await db.insert(chatThreads).values(values).returning();
    assert.equal(created?.id, id);
    assert.equal(created?.userId, values.userId);
    assert.equal(created?.title, values.title);
    assert.equal(created?.muted, false);
    assert.equal(created?.archived, false);
    assert.deepEqual(created?.modelSettings, {});

    const [upserted] = await db
      .insert(chatThreads)
      .values(values)
      .onConflictDoUpdate({
        target: chatThreads.id,
        set: { title: "Renamed thread", muted: true },
      })
      .returning();
    assert.equal(upserted?.id, id);
    assert.equal(upserted?.title, "Renamed thread");
    assert.equal(upserted?.muted, true);
    assert.equal(upserted?.createdAt.getTime(), created?.createdAt.getTime());

    const [selected] = await db
      .select()
      .from(chatThreads)
      .where(eq(chatThreads.id, id));
    assert.deepEqual(selected, upserted);
    assert.deepEqual(
      await db.query.chatThreads.findFirst({ where: eq(chatThreads.id, id) }),
      selected,
    );

    const [updated] = await db
      .update(chatThreads)
      .set({ archived: true })
      .where(eq(chatThreads.id, id))
      .returning();
    assert.equal(updated?.archived, true);
    assert.equal(updated?.muted, true);
    assert.equal(updated?.title, "Renamed thread");
    assert.equal(updated?.userId, values.userId);

    const [deleted] = await db
      .delete(chatThreads)
      .where(eq(chatThreads.id, id))
      .returning();
    assert.deepEqual(deleted, updated);
    assert.equal(
      await db.query.chatThreads.findFirst({ where: eq(chatThreads.id, id) }),
      undefined,
    );
    console.log(
      "Current thread SQL and root-schema reads preserve identity and metadata",
    );
  } finally {
    try {
      await db.delete(chatThreads).where(eq(chatThreads.id, id));
    } finally {
      await client.end();
    }
  }
}
