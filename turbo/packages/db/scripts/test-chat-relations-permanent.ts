import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { chatRelations } from "../src/schema/chat-relation";

/** Creation identity and accepted-message identity are independent facts. */
export async function validateChatRelations(databaseUrl: string) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const db = drizzle(client);
  const orgId = `chat-relations-${randomUUID()}`;
  const action = {
    orgId,
    userId: "schema-validation",
    sourceChatThreadId: randomUUID(),
    targetChatThreadId: randomUUID(),
    sourceRunId: randomUUID(),
  };
  try {
    await db.insert(chatRelations).values({ ...action, type: "created" });
    await assert.rejects(
      db.insert(chatRelations).values({ ...action, type: "created" }),
    );
    await assert.rejects(
      db.insert(chatRelations).values({ ...action, type: "message" }),
    );
    await assert.rejects(
      db
        .insert(chatRelations)
        .values({
          ...action,
          type: "message",
          messageEventId: randomUUID(),
          targetChatThreadId: action.sourceChatThreadId,
        }),
    );
    await assert.rejects(
      db
        .insert(chatRelations)
        .values({
          ...action,
          type: "created",
          targetChatThreadId: randomUUID(),
          targetRunId: randomUUID(),
        }),
    );
    await assert.rejects(
      db
        .insert(chatRelations)
        .values({
          ...action,
          type: "created",
          targetChatThreadId: randomUUID(),
          messageEventId: randomUUID(),
        }),
    );
    const messageEventId = randomUUID();
    await db
      .insert(chatRelations)
      .values({ ...action, type: "message", messageEventId });
    await assert.rejects(
      db
        .insert(chatRelations)
        .values({ ...action, type: "message", messageEventId }),
    );
    const targetRunId = randomUUID();
    await db
      .update(chatRelations)
      .set({ targetRunId })
      .where(eq(chatRelations.messageEventId, messageEventId));
    const [received] = await db
      .select()
      .from(chatRelations)
      .where(eq(chatRelations.messageEventId, messageEventId));
    assert.equal(received?.targetRunId, targetRunId);
    assert.equal(received?.messageEventId, messageEventId);
    await db
      .insert(chatRelations)
      .values({ ...action, type: "message", messageEventId: randomUUID() });
    console.log(
      "Chat relations preserve unique creation and per-message identities",
    );
  } finally {
    try {
      await db.delete(chatRelations).where(eq(chatRelations.orgId, orgId));
    } finally {
      await client.end();
    }
  }
}
