import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { z } from "zod";
import { jsonb, pgTable } from "drizzle-orm/pg-core";

import { schema } from "../src/index";
import { agentSessions } from "../src/schema/agent-session";
import { agentSessionColumns } from "../src/columns/agent-session";
import { resolveAgentConversationId } from "../src/schema/agent-run-reference";
import type { PersistedStorageMount } from "../src/types";

// The outgoing projection is a fixture; production mappings omit this column.
const retainedSessions = pgTable("agent_sessions", {
  ...agentSessionColumns(resolveAgentConversationId),
  storageMounts: jsonb("storage_mounts").$type<PersistedStorageMount[]>(),
});

// The consistency suite temporarily replaces the migration directory while
// generating a fresh schema. Capture the actual preparation before that phase.
const preparationSql = await readFile(
  new URL(
    "../src/migrations/1377_prepare_session_mount_retirement.sql",
    import.meta.url,
  ),
  "utf8",
);
const contractionSql = await readFile(
  new URL(
    "../src/migrations/1384_retire_session_storage_mounts.sql",
    import.meta.url,
  ),
  "utf8",
);

function hasUndefinedColumn(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.cause instanceof Error &&
    "code" in error.cause &&
    error.cause.code === "42703"
  );
}

/** Retain until the physical contraction is deployed and accepted under #39310. */
export async function validateSessionMountRetirementPreparation(
  databaseUrl: string,
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  // Freeze the outgoing root projection for this historical preparation proof.
  // The application root schema has since retired Session ownership entirely.
  const db = drizzle(client, { schema: { ...schema, agentSessions } });
  const namespace = `session_mounts_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query(`CREATE SCHEMA "${namespace}"`);
    await client.query(
      `CREATE TABLE "${namespace}".agent_sessions (LIKE public.agent_sessions INCLUDING ALL)`,
    );
    await client.query(`SET search_path TO "${namespace}", public`);
    await client.query(
      "ALTER TABLE agent_sessions ADD COLUMN storage_mounts jsonb",
    );

    const userId = `user-${namespace}`;
    const orgId = namespace;
    const agentId = randomUUID();
    const conversationId = randomUUID();
    const memory: PersistedStorageMount = {
      orgId,
      userId,
      name: "memory",
      storageId: randomUUID(),
      mountPath: "/home/user/.pi/agent/memory",
      writeback: true,
      missingRootPolicy: "preserveParentVersion",
    };
    const legacyMounts = [
      null,
      [],
      [memory],
      [{ ...memory, version: "a".repeat(64) }],
      [{ ...memory, name: "legacy-output", mountPath: "/workspace/output" }],
    ];
    const historical = legacyMounts.map((storageMounts) => {
      return {
        id: randomUUID(),
        userId,
        orgId,
        agentId,
        conversationId,
        storageMounts,
      };
    });
    await db.insert(retainedSessions).values(historical);

    const readLegacyMounts = async () => {
      const result = await client.query(
        "SELECT id, storage_mounts::text AS mounts FROM agent_sessions ORDER BY id",
      );
      return z
        .array(z.object({ id: z.string(), mounts: z.string().nullable() }))
        .parse(result.rows);
    };
    const before = await readLegacyMounts();
    await client.query(preparationSql);
    assert.deepEqual(await readLegacyMounts(), before);

    // The outgoing reader still selects the physical column after preparation.
    const outgoing = await db.select().from(retainedSessions);
    assert.equal(outgoing.length, historical.length);
    for (const row of outgoing) {
      assert.deepEqual(
        row.storageMounts,
        historical.find((previous) => {
          return previous.id === row.id;
        })?.storageMounts,
      );
    }

    for (const phase of ["retained", "contracted"] as const) {
      if (phase === "contracted") {
        await client.query(contractionSql);
      }
      const id = randomUUID();
      const identity = { id, userId, orgId, agentId, conversationId };
      const [inserted] = await db
        .insert(agentSessions)
        .values(identity)
        .returning();
      assert.ok(inserted);
      assert.equal(Object.hasOwn(inserted, "storageMounts"), false);
      assert.equal(inserted.agentId, agentId);
      assert.equal(inserted.conversationId, conversationId);

      if (phase === "retained") {
        // New writes omitted the column. PostgreSQL, not application code,
        // supplies [] so an old continuation reader does not encounter NULL.
        const [oldRead] = await db
          .select()
          .from(retainedSessions)
          .where(eq(retainedSessions.id, id));
        assert.deepEqual(oldRead?.storageMounts, []);
        await db.insert(retainedSessions).values({
          id: randomUUID(),
          userId,
          orgId,
          storageMounts: [memory],
        });
      }

      const current = await db.query.agentSessions.findFirst({
        where: eq(agentSessions.id, id),
      });
      assert.equal(current?.id, id);
      assert.equal(Object.hasOwn(current ?? {}, "storageMounts"), false);

      const nextConversationId = randomUUID();
      const [upserted] = await db
        .insert(agentSessions)
        .values(identity)
        .onConflictDoUpdate({
          target: agentSessions.id,
          set: { conversationId: nextConversationId },
        })
        .returning();
      assert.equal(upserted?.conversationId, nextConversationId);
      const [updated] = await db
        .update(agentSessions)
        .set({ conversationId })
        .where(eq(agentSessions.id, id))
        .returning();
      assert.equal(updated?.conversationId, conversationId);

      for (const previous of historical) {
        const retained = await db.query.agentSessions.findFirst({
          where: eq(agentSessions.id, previous.id),
        });
        assert.equal(retained?.agentId, previous.agentId);
        assert.equal(retained?.conversationId, previous.conversationId);
      }

      if (phase === "contracted") {
        // The old mapping is intentionally incompatible after contraction;
        // its SQL/rollback consumers must have drained before Release 2.
        await assert.rejects(
          db.select().from(retainedSessions),
          hasUndefinedColumn,
        );
        await assert.rejects(
          db.insert(retainedSessions).values({ userId, orgId }).returning(),
          hasUndefinedColumn,
        );
      }
      const [deleted] = await db
        .delete(agentSessions)
        .where(eq(agentSessions.id, id))
        .returning();
      assert.equal(deleted?.id, id);
    }
  } finally {
    await client.query("SET search_path TO public");
    await client.query(`DROP SCHEMA "${namespace}" CASCADE`);
    await client.end();
  }
}
