import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import postgres from "postgres";

import { schema } from "../src/index";
import { chatThreads } from "../src/runtime/chat-thread";
import { chatThreads as outgoingThreads } from "../src/schema/chat-thread";
import { applyPendingMigrations } from "./migration-runner";

// The configured connection only creates/drops an owned disposable database.
// No physical contraction is shipped by this runtime preparation.
const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
const databaseName = `thread_provenance_${randomUUID().replaceAll("-", "")}`;
const ownedUrl = new URL(adminUrl);
ownedUrl.pathname = `/${databaseName}`;
const admin = new Client({ connectionString: adminUrl.toString() });
await admin.connect();
await admin.query(`CREATE DATABASE "${databaseName}"`);
const migrationSql = postgres(ownedUrl.toString(), {
  max: 1,
  onnotice: () => {},
});
const client = new Client({ connectionString: ownedUrl.toString() });
const db = drizzle(client, { schema });

try {
  await client.connect();
  await applyPendingMigrations(migrationSql);

  // The retained physical mapping still emits the outgoing SQL column lists.
  const historicalId = randomUUID();
  const [historical] = await db
    .insert(outgoingThreads)
    .values({
      id: historicalId,
      userId: "thread-provenance-owner",
      title: "Historical brief",
      provenance: "morning_brief",
    })
    .returning();
  assert.equal(historical?.provenance, "morning_brief");

  for (const shape of ["retained", "contracted"] as const) {
    if (shape === "contracted") {
      // Test-only simulation: the actual DROP requires a separate later release.
      await client.query("ALTER TABLE chat_threads DROP COLUMN provenance");
    }

    const historicalRead = await db.query.chatThreads.findFirst({
      where: eq(chatThreads.id, historicalId),
    });
    assert.equal(historicalRead?.title, "Historical brief");
    assert.equal(historicalRead?.userId, "thread-provenance-owner");

    const id = randomUUID();
    const values = {
      id,
      userId: "thread-provenance-owner",
      title: `${shape} thread`,
    };
    const [created] = await db.insert(chatThreads).values(values).returning();
    assert.equal(created?.id, id);
    assert.equal(created?.title, values.title);
    assert.equal(created?.muted, false);
    assert.equal(created?.archived, false);
    assert.deepEqual(created?.modelSettings, {});

    const [upserted] = await db
      .insert(chatThreads)
      .values(values)
      .onConflictDoUpdate({
        target: chatThreads.id,
        set: { title: `${shape} renamed`, muted: true },
      })
      .returning();
    assert.equal(upserted?.id, id);
    assert.equal(upserted?.title, `${shape} renamed`);
    assert.equal(upserted?.muted, true);

    const [selected] = await db
      .select()
      .from(chatThreads)
      .where(eq(chatThreads.id, id));
    assert.deepEqual(selected, upserted);
    const rootSelected = await db.query.chatThreads.findFirst({
      where: eq(chatThreads.id, id),
    });
    assert.deepEqual(rootSelected, selected);

    const [updated] = await db
      .update(chatThreads)
      .set({ archived: true })
      .where(eq(chatThreads.id, id))
      .returning();
    assert.equal(updated?.archived, true);
    assert.equal(updated?.muted, true);
    assert.equal(updated?.title, `${shape} renamed`);

    if (shape === "retained") {
      const [outgoingRead] = await db
        .select()
        .from(outgoingThreads)
        .where(eq(outgoingThreads.id, historicalId));
      assert.equal(outgoingRead?.provenance, "morning_brief");
      const [outgoingUpdate] = await db
        .update(outgoingThreads)
        .set({ archived: true })
        .where(eq(outgoingThreads.id, id))
        .returning();
      assert.equal(outgoingUpdate?.provenance, null);
      assert.equal(outgoingUpdate?.title, `${shape} renamed`);
    }

    const [deleted] = await db
      .delete(chatThreads)
      .where(eq(chatThreads.id, id))
      .returning();
    assert.equal(deleted?.id, id);
    assert.equal(
      await db.query.chatThreads.findFirst({ where: eq(chatThreads.id, id) }),
      undefined,
    );
  }

  console.log(
    "Thread runtime and root-schema INSERT/UPSERT/SELECT/UPDATE/DELETE with implicit RETURNING work before and after simulated provenance contraction; outgoing SQL and historical values remain valid during preparation.",
  );
} finally {
  await client.end();
  await migrationSql.end();
  await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await admin.end();
}
