import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import postgres from "postgres";
import { z } from "zod";

import { DRIZZLE_MIGRATE_OUT } from "../drizzle.config";
import { schema } from "../src/index";
import { sshConnections } from "../src/runtime/ssh-connection";
import { sshCredentials } from "../src/schema/ssh-credential";
import { cloudflareAccessConfigs } from "../src/schema/cloudflare-access-config";
import { tailscaleConfigs } from "../src/schema/tailscale-config";
import { outgoingSshConnections } from "./fixtures/ssh-needs-rebind-outgoing";
import { applyPendingMigrations } from "./migration-runner";
import { validatePermanentSshStorage } from "./test-ssh-storage-permanent";

// Keep through the separately released physical contraction under #39380.
const journal = z
  .object({ entries: z.array(z.object({ tag: z.string(), when: z.number() })) })
  .parse(
    JSON.parse(
      await readFile(`${DRIZZLE_MIGRATE_OUT}/meta/_journal.json`, "utf8"),
    ),
  );
const preparation = journal.entries.find((entry) => {
  return entry.tag.endsWith("_prepare_ssh_needs_rebind_retirement");
});
assert.ok(preparation);
const contraction = journal.entries.find((entry) => {
  return entry.tag.endsWith("_drop_ssh_needs_rebind");
});
assert.ok(contraction && contraction.when > preparation.when);
const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
const name = `ssh_preparation_${randomUUID().replaceAll("-", "")}`;
const ownedUrl = new URL(adminUrl);
ownedUrl.pathname = `/${name}`;
const admin = new Client({ connectionString: adminUrl.toString() });
let created = false;
const migrationSql = postgres(ownedUrl.toString(), {
  max: 1,
  onnotice: () => {},
});
const client = new Client({ connectionString: ownedUrl.toString() });
const db = drizzle(client, { schema });

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  await client.connect();
  await applyPendingMigrations(migrationSql, {
    beforeMillis: preparation.when,
  });
  const owner = { orgId: "ssh-preparation-org", userId: "ssh-owner" };
  const [credential] = await db
    .insert(sshCredentials)
    .values({
      ...owner,
      name: "Login",
      username: "deploy",
      authMethod: "password",
      encryptedPassword: "synthetic-ciphertext",
    })
    .returning();
  assert.ok(credential);
  const [access] = await db
    .insert(cloudflareAccessConfigs)
    .values({
      ...owner,
      name: "Access",
      encryptedClientId: "synthetic-id",
      encryptedClientSecret: "synthetic-secret",
    })
    .returning();
  const [tailscale] = await db
    .insert(tailscaleConfigs)
    .values({
      ...owner,
      name: "Tailscale",
      encryptedClientId: "synthetic-id",
      encryptedClientSecret: "synthetic-secret",
      tags: ["tag:ssh"],
    })
    .returning();
  assert.ok(access && tailscale);
  const historical = await db
    .insert(outgoingSshConnections)
    .values([
      {
        ...owner,
        displayName: "Retained Access",
        host: "retained.example.com",
        port: 443,
        credentialId: credential.id,
        transport: "cloudflare_access",
        legacyNeedsRebind: true,
        generation: 7,
        learnedHostKeyAlgorithm: "ssh-ed25519",
        learnedHostKeyFingerprint: "SHA256:retained",
      },
      {
        ...owner,
        displayName: "Bound Tailscale",
        host: "100.64.0.1",
        credentialId: credential.id,
        transport: "tailscale",
        tailscaleId: tailscale.id,
        generation: 9,
        learnedHostKeyAlgorithm: "ssh-ed25519",
        learnedHostKeyFingerprint: "SHA256:tailnet",
      },
    ])
    .returning();
  await applyPendingMigrations(migrationSql, {
    beforeMillis: preparation.when + 1,
  });
  assert.deepEqual(
    await db
      .select()
      .from(outgoingSshConnections)
      .orderBy(outgoingSshConnections.id),
    [...historical].sort((a, b) => {
      return a.id.localeCompare(b.id);
    }),
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='ssh_connections' AND column_name='needs_rebind'",
      )
    ).rows,
    [{ is_nullable: "NO", column_default: "false" }],
  );
  // Exact outgoing implicit INSERT/RETURNING and UPDATE remain legal.
  const [outgoing] = await db
    .insert(outgoingSshConnections)
    .values({
      ...owner,
      displayName: "Outgoing API",
      host: "old.example.com",
      credentialId: credential.id,
      transport: "direct",
    })
    .returning();
  assert.ok(outgoing);
  const [outgoingUpdated] = await db
    .update(outgoingSshConnections)
    .set({
      transport: "cloudflare_access",
      port: 443,
      legacyNeedsRebind: true,
    })
    .where(eq(outgoingSshConnections.id, outgoing.id))
    .returning();
  assert.ok(outgoingUpdated);
  assert.equal(outgoingUpdated.legacyNeedsRebind, true);
  await db
    .delete(outgoingSshConnections)
    .where(eq(outgoingSshConnections.id, outgoing.id));

  const snapshot = await db
    .select()
    .from(sshConnections)
    .orderBy(sshConnections.id);
  for (const phase of ["retained", "contracted"] as const) {
    if (phase === "contracted") {
      await applyPendingMigrations(migrationSql, {
        beforeMillis: contraction.when,
      });
      const journalBefore = (
        await client.query<{ id: number; hash: string; created_at: string }>(
          "SELECT * FROM drizzle.__drizzle_migrations ORDER BY id",
        )
      ).rows;
      // Local indexes/checks auto-drop under RESTRICT; text routines have no
      // column dependency. The actual migration must refuse every consumer.
      for (const dependency of [
        {
          create:
            "CREATE INDEX ssh_rebind_unexpected_index ON ssh_connections (needs_rebind)",
          drop: "DROP INDEX ssh_rebind_unexpected_index",
        },
        {
          create:
            "ALTER TABLE ssh_connections ADD CONSTRAINT ssh_rebind_unexpected_check CHECK (NOT needs_rebind OR transport <> 'direct')",
          drop: "ALTER TABLE ssh_connections DROP CONSTRAINT ssh_rebind_unexpected_check",
        },
        {
          create:
            "CREATE VIEW ssh_rebind_unexpected_view AS SELECT needs_rebind FROM ssh_connections",
          drop: "DROP VIEW ssh_rebind_unexpected_view",
        },
        {
          create:
            "CREATE FUNCTION ssh_rebind_unexpected_routine() RETURNS boolean LANGUAGE sql AS $$ SELECT needs_rebind FROM ssh_connections LIMIT 1 $$",
          drop: "DROP FUNCTION ssh_rebind_unexpected_routine()",
        },
        {
          create:
            "CREATE FUNCTION ssh_rebind_parsed_routine() RETURNS boolean LANGUAGE sql RETURN (SELECT needs_rebind FROM ssh_connections LIMIT 1)",
          drop: "DROP FUNCTION ssh_rebind_parsed_routine()",
        },
        {
          create:
            "CREATE VIEW ssh_rebind_whole_row_view AS SELECT ssh_connections AS host FROM ssh_connections",
          drop: "DROP VIEW ssh_rebind_whole_row_view",
        },
        {
          create:
            "CREATE FUNCTION ssh_rebind_row_type(host ssh_connections) RETURNS text LANGUAGE sql AS $$ SELECT host.host $$",
          drop: "DROP FUNCTION ssh_rebind_row_type(ssh_connections)",
        },
        {
          create:
            "ALTER TABLE ssh_connections ALTER COLUMN needs_rebind SET DEFAULT true",
          drop: "ALTER TABLE ssh_connections ALTER COLUMN needs_rebind SET DEFAULT false",
        },
      ]) {
        await client.query(dependency.create);
        try {
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
                  "Unexpected SSH needs_rebind dependencies",
                )
              );
            },
          );
          assert.deepEqual(
            (
              await client.query<{
                id: number;
                hash: string;
                created_at: string;
              }>("SELECT * FROM drizzle.__drizzle_migrations ORDER BY id")
            ).rows,
            journalBefore,
            "Rejected contraction must not advance the migration journal",
          );
          assert.deepEqual(
            await db
              .select()
              .from(outgoingSshConnections)
              .orderBy(outgoingSshConnections.id),
            [...historical].sort((a, b) => {
              return a.id.localeCompare(b.id);
            }),
            "Rejected contraction must retain storage and historical host state",
          );
        } finally {
          await client.query(dependency.drop);
        }
      }
      await applyPendingMigrations(migrationSql, {
        beforeMillis: contraction.when + 1,
      });
      assert.deepEqual(
        (
          await client.query(
            "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='ssh_connections' AND column_name='needs_rebind'",
          )
        ).rows,
        [],
        "The actual contraction must remove physical compatibility storage",
      );
      // A successful migration replay is a no-op, not a second destructive DROP.
      await applyPendingMigrations(migrationSql, {
        beforeMillis: contraction.when + 1,
      });
    }
    assert.deepEqual(
      await db.select().from(sshConnections).orderBy(sshConnections.id),
      snapshot,
    );
    assert.deepEqual(
      await db.query.sshConnections.findMany({ orderBy: sshConnections.id }),
      snapshot,
    );
    await validatePermanentSshStorage(ownedUrl.toString());
    assert.deepEqual(
      await db.select().from(sshConnections).orderBy(sshConnections.id),
      snapshot,
      "Canonical CRUD must leave the pre-existing identities, pins and generations intact",
    );
  }
  console.log(
    "SSH preparation and actual contraction preserve canonical hosts and reject unexpected catalog consumers",
  );
} finally {
  try {
    await client.end();
  } finally {
    try {
      await migrationSql.end();
    } finally {
      try {
        if (created) {
          await admin.query(`DROP DATABASE "${name}"`);
        }
      } finally {
        await admin.end();
      }
    }
  }
}
