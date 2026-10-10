import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import postgres from "postgres";
import { z } from "zod";

import { DRIZZLE_MIGRATE_OUT } from "../drizzle.config";
import { schema } from "../src/index";
import { computerUseHosts } from "../src/runtime/computer-use-host";
import { chatThreads } from "../src/runtime/chat-thread";
import {
  computerUseCommands,
  computerUseCommandAuditEvents,
} from "../src/schema/computer-use-host";
import { applyPendingMigrations } from "./migration-runner";
import { outgoingHosts } from "./fixtures/computer-use-host-token-outgoing";

const journal = z
  .object({ entries: z.array(z.object({ tag: z.string(), when: z.number() })) })
  .parse(
    JSON.parse(
      await readFile(`${DRIZZLE_MIGRATE_OUT}/meta/_journal.json`, "utf8"),
    ),
  );
const preparation = journal.entries.find((entry) => {
  return entry.tag.endsWith("_prepare_computer_use_host_token_retirement");
});
assert.ok(preparation, "Retain this validator through physical contraction");
const contraction = journal.entries.find((entry) => {
  return entry.tag.endsWith("_drop_computer_use_host_token_hash");
});
assert.ok(
  contraction,
  "The physical contraction must exercise the real migration",
);

// Only an owned disposable database is changed, including the actual DROP.
const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
const databaseName = `host_token_preparation_${randomUUID().replaceAll("-", "")}`;
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
    beforeMillis: preparation.when,
  });
  const legacyId = randomUUID();
  const nativeId = randomUUID();
  const installationId = randomUUID();
  const now = new Date("2026-10-10T00:00:00Z");
  const historical = await db
    .insert(outgoingHosts)
    .values([
      {
        id: legacyId,
        orgId: "host-token-org",
        userId: "host-token-owner",
        installationId,
        displayName: "Historical installation",
        tokenHash: "retired-legacy-hash",
        sessionId: null,
        connectionGeneration: 7,
        appVersion: "0.50.1",
        osVersion: "15.0",
        lastSeenAt: now,
      },
      {
        id: nativeId,
        orgId: "host-token-org",
        userId: "host-token-owner",
        installationId: randomUUID(),
        displayName: "Session installation",
        tokenHash: "retired-session-installation-hash",
        sessionId: "sess_native",
        sessionValidatedAt: now,
        connectionGeneration: 3,
        appVersion: "0.52.1",
        osVersion: "15.0",
        lastSeenAt: now,
      },
      {
        orgId: "host-token-org",
        userId: "host-token-owner",
        displayName: "Already session-only",
        tokenHash: null,
        sessionId: "sess_unchanged",
        connectionGeneration: 2,
        appVersion: "0.52.1",
        osVersion: "15.0",
      },
      {
        orgId: "host-token-org",
        userId: "host-token-owner",
        displayName: "Revoked installation",
        tokenHash: "retired-revoked-hash",
        sessionId: null,
        revokedAt: now,
        appVersion: "0.49.0",
        osVersion: "15.0",
      },
    ])
    .returning();
  const [command] = await db
    .insert(computerUseCommands)
    .values({
      hostId: legacyId,
      orgId: "host-token-org",
      userId: "host-token-owner",
      kind: "apps.list",
      status: "completed",
      timeoutMs: 30_000,
      claimedConnectionGeneration: 7,
      completedAt: now,
    })
    .returning();
  assert.ok(command);
  await db.insert(computerUseCommandAuditEvents).values({
    commandId: command.id,
    hostId: legacyId,
    orgId: "host-token-org",
    userId: "host-token-owner",
    kind: "apps.list",
    event: "completed",
  });
  await db.insert(chatThreads).values({
    userId: "host-token-owner",
    title: "Retained device binding",
    computerUseHostId: legacyId,
  });
  const commandsBefore = await db.select().from(computerUseCommands);
  const auditsBefore = await db.select().from(computerUseCommandAuditEvents);
  const threadsBefore = await db.select().from(chatThreads);

  await applyPendingMigrations(migrationSql, {
    beforeMillis: preparation.when + 1,
  });
  for (const before of historical) {
    const [after] = await db
      .select()
      .from(outgoingHosts)
      .where(eq(outgoingHosts.id, before.id));
    assert.deepEqual(after, {
      ...before,
      tokenHash: null,
      status: before.sessionId === null ? "offline" : before.status,
    });
  }
  assert.deepEqual(await db.select().from(computerUseCommands), commandsBefore);
  assert.deepEqual(
    await db.select().from(computerUseCommandAuditEvents),
    auditsBefore,
  );
  assert.deepEqual(await db.select().from(chatThreads), threadsBefore);
  assert.ok(
    (
      await client.query(
        "SELECT to_regclass('idx_computer_use_hosts_token_hash') AS name",
      )
    ).rows[0]?.name,
    "The preparation must retain the physical index",
  );
  // Migration reruns do not change devices, bindings, commands or generations.
  await applyPendingMigrations(migrationSql, {
    beforeMillis: preparation.when + 1,
  });

  for (const shape of ["retained", "contracted"] as const) {
    if (shape === "contracted") {
      await applyPendingMigrations(migrationSql, {
        beforeMillis: contraction.when,
      });
      const hostsBefore = await db
        .select()
        .from(computerUseHosts)
        .orderBy(computerUseHosts.id);
      const journalBefore = (
        await client.query(
          "SELECT * FROM drizzle.__drizzle_migrations ORDER BY id",
        )
      ).rows;
      // RESTRICT silently drops local indexes/checks and cannot discover
      // string-bodied SQL routines; the census must refuse all four kinds.
      for (const dependency of [
        {
          create:
            "CREATE INDEX host_token_unexpected_index ON computer_use_hosts (token_hash)",
          drop: "DROP INDEX host_token_unexpected_index",
        },
        {
          create:
            "ALTER TABLE computer_use_hosts ADD CONSTRAINT host_token_unexpected_check CHECK (token_hash IS NULL)",
          drop: "ALTER TABLE computer_use_hosts DROP CONSTRAINT host_token_unexpected_check",
        },
        {
          create:
            "CREATE VIEW host_token_unexpected_view AS SELECT token_hash FROM computer_use_hosts",
          drop: "DROP VIEW host_token_unexpected_view",
        },
        {
          create:
            "CREATE FUNCTION host_token_unexpected_routine() RETURNS text LANGUAGE sql AS $$ SELECT token_hash FROM computer_use_hosts LIMIT 1 $$",
          drop: "DROP FUNCTION host_token_unexpected_routine()",
        },
      ]) {
        await client.query(dependency.create);
        await assert.rejects(
          applyPendingMigrations(migrationSql, {
            beforeMillis: contraction.when + 1,
          }),
          (error: unknown) => {
            return (
              error instanceof Error &&
              "code" in error &&
              error.code === "2BP01" &&
              error.message.includes(
                "Unexpected Computer Use host token dependencies",
              )
            );
          },
        );
        assert.deepEqual(
          (
            await client.query(
              "SELECT * FROM drizzle.__drizzle_migrations ORDER BY id",
            )
          ).rows,
          journalBefore,
        );
        assert.ok(
          (
            await client.query(
              "SELECT to_regclass('idx_computer_use_hosts_token_hash') AS name",
            )
          ).rows[0]?.name,
          "Rejected contraction must retain the expected index",
        );
        assert.equal(
          (await db.select().from(outgoingHosts))[0]?.tokenHash,
          null,
          "Rejected contraction must retain the column",
        );
        await client.query(dependency.drop);
      }
      await client.query(
        "UPDATE computer_use_hosts SET token_hash = 'unexpected-writer-hash' WHERE id = $1",
        [legacyId],
      );
      await assert.rejects(
        applyPendingMigrations(migrationSql, {
          beforeMillis: contraction.when + 1,
        }),
        /Host token hashes remain after retirement preparation/,
      );
      assert.deepEqual(
        (
          await client.query(
            "SELECT * FROM drizzle.__drizzle_migrations ORDER BY id",
          )
        ).rows,
        journalBefore,
      );
      await client.query(
        "UPDATE computer_use_hosts SET token_hash = NULL WHERE id = $1",
        [legacyId],
      );
      await applyPendingMigrations(migrationSql, {
        beforeMillis: contraction.when + 1,
      });
      assert.deepEqual(
        await db.select().from(computerUseHosts).orderBy(computerUseHosts.id),
        hostsBefore,
        "DROP must preserve every retained host field",
      );
      assert.equal(
        (
          await client.query(
            "SELECT to_regclass('idx_computer_use_hosts_token_hash') AS name",
          )
        ).rows[0]?.name,
        null,
      );
      await applyPendingMigrations(migrationSql, {
        beforeMillis: contraction.when + 1,
      });
    }
    const [native] = await db
      .select()
      .from(computerUseHosts)
      .where(eq(computerUseHosts.id, nativeId));
    assert.equal(native?.sessionId, "sess_native");
    assert.equal(native?.status, "online");
    assert.deepEqual(
      await db.query.computerUseHosts.findFirst({
        where: eq(computerUseHosts.id, nativeId),
      }),
      native,
    );

    // A verified registration reuses the historical installation and host id;
    // no token_hash column may appear in implicit INSERT or RETURNING lists.
    const [upgraded] = await db
      .insert(computerUseHosts)
      .values({
        orgId: "host-token-org",
        userId: "host-token-owner",
        installationId,
        displayName: `${shape} upgraded installation`,
        sessionId: "sess_upgraded",
        appVersion: "0.52.1",
        osVersion: "15.0",
      })
      .onConflictDoUpdate({
        target: [
          computerUseHosts.orgId,
          computerUseHosts.userId,
          computerUseHosts.installationId,
        ],
        targetWhere: and(
          isNotNull(computerUseHosts.installationId),
          isNull(computerUseHosts.revokedAt),
        ),
        set: {
          sessionId: "sess_upgraded",
          status: "online",
          connectionGeneration: sql`${computerUseHosts.connectionGeneration} + 1`,
        },
      })
      .returning();
    assert.equal(upgraded?.id, legacyId);
    assert.equal(upgraded?.connectionGeneration, shape === "retained" ? 8 : 9);
    assert.equal(upgraded?.sessionId, "sess_upgraded");
    assert.deepEqual(await db.select().from(chatThreads), threadsBefore);
    assert.deepEqual(
      await db.select().from(computerUseCommands),
      commandsBefore,
    );
    assert.deepEqual(
      await db.select().from(computerUseCommandAuditEvents),
      auditsBefore,
    );

    const [created] = await db
      .insert(computerUseHosts)
      .values({
        orgId: "host-token-org",
        userId: "host-token-owner",
        installationId: randomUUID(),
        displayName: `${shape} new installation`,
        sessionId: "sess_new",
        appVersion: "0.52.1",
        osVersion: "15.0",
      })
      .returning();
    assert.ok(created);
    const [stopped] = await db
      .update(computerUseHosts)
      .set({ status: "offline" })
      .where(eq(computerUseHosts.id, created.id))
      .returning();
    assert.equal(stopped?.status, "offline");

    if (shape === "retained") {
      const [outgoing] = await db
        .select()
        .from(outgoingHosts)
        .where(eq(outgoingHosts.id, legacyId));
      assert.equal(outgoing?.tokenHash, null);
      assert.equal(outgoing?.sessionId, "sess_upgraded");
      assert.equal(outgoing?.status, "online");
    }
  }
  console.log(
    "Computer Use host-token preparation and contracted-runtime validation passed",
  );
} finally {
  await client.end();
  await migrationSql.end();
  await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await admin.end();
}
