import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, varchar } from "drizzle-orm/pg-core";
import { Client } from "pg";
import postgres from "postgres";
import { z } from "zod";

import { DRIZZLE_MIGRATE_OUT } from "../drizzle.config";
import { chatThreadColumns } from "../src/columns/chat-thread";
import { schema } from "../src/index";
import { chatThreads } from "../src/runtime/chat-thread";
import { applyPendingMigrations } from "./migration-runner";

// The preceding physical column list remains only as a transition fixture.
const outgoingThreads = pgTable("chat_threads", {
  ...chatThreadColumns(),
  provenance: varchar("provenance", { length: 32 }),
});
const journal = z
  .object({ entries: z.array(z.object({ tag: z.string(), when: z.number() })) })
  .parse(
    JSON.parse(
      await readFile(`${DRIZZLE_MIGRATE_OUT}/meta/_journal.json`, "utf8"),
    ),
  );
const entry = journal.entries.find((item) => {
  return item.tag.endsWith("_drop_chat_thread_provenance");
});
assert.ok(entry, "Retain this validator through production contraction");
const contraction = readMigrationFiles({
  migrationsFolder: DRIZZLE_MIGRATE_OUT,
}).find((item) => {
  return item.folderMillis === entry.when;
});
assert.ok(contraction);

// The configured connection only creates/drops an owned disposable database.
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
  await applyPendingMigrations(migrationSql, {
    beforeMillis: contraction.folderMillis,
  });

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

  const applyContraction = () => {
    return applyPendingMigrations(migrationSql, {
      beforeMillis: contraction.folderMillis + 1,
    });
  };
  const journalBefore = await client.query(
    "SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at",
  );
  // Local indexes would be removed automatically even by DROP ... RESTRICT.
  // Views are tracked dependents; string-bodied SQL functions are not.
  for (const dependency of [
    {
      create: "CREATE INDEX provenance_dependency ON chat_threads (provenance)",
      drop: "DROP INDEX provenance_dependency",
    },
    {
      create:
        "CREATE VIEW provenance_dependency AS SELECT provenance FROM chat_threads",
      drop: "DROP VIEW provenance_dependency",
    },
    {
      create:
        "CREATE FUNCTION provenance_dependency() RETURNS text LANGUAGE sql AS 'SELECT provenance FROM chat_threads LIMIT 1'",
      drop: "DROP FUNCTION provenance_dependency()",
    },
  ]) {
    await client.query(dependency.create);
    await assert.rejects(
      applyContraction(),
      /Unexpected chat thread provenance dependencies/,
    );
    assert.deepEqual(
      (
        await client.query(
          "SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at",
        )
      ).rows,
      journalBefore.rows,
    );
    const [preserved] = await db
      .select()
      .from(outgoingThreads)
      .where(eq(outgoingThreads.id, historicalId));
    assert.equal(preserved?.provenance, "morning_brief");
    await client.query(dependency.drop);
  }

  for (const shape of ["retained", "contracted"] as const) {
    if (shape === "contracted") {
      const before = await db.select().from(chatThreads);
      await applyContraction();
      assert.deepEqual(await db.select().from(chatThreads), before);
      assert.deepEqual(
        (
          await client.query(
            "SELECT attname FROM pg_attribute WHERE attrelid = 'chat_threads'::regclass AND attname = 'provenance' AND NOT attisdropped",
          )
        ).rows,
        [],
      );
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

  const journalAfter = await client.query(
    "SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at",
  );
  await applyContraction();
  assert.deepEqual(
    (
      await client.query(
        "SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at",
      )
    ).rows,
    journalAfter.rows,
  );

  console.log(
    "Thread SQL and retained history survive provenance contraction; unexpected indexes/views/routine references abort before DROP and journal advancement; completed migration retries are no-ops.",
  );
} finally {
  await client.end();
  await migrationSql.end();
  await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await admin.end();
}
