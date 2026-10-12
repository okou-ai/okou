import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import postgres from "postgres";
import { z } from "zod";

import { DRIZZLE_MIGRATE_OUT } from "../drizzle.config";
import { schema } from "../src/index";
import {
  sshConnections,
  sshConnectionNeedsRebind,
} from "../src/runtime/ssh-connection";
import { sshCredentials } from "../src/schema/ssh-credential";
import { cloudflareAccessConfigs } from "../src/schema/cloudflare-access-config";
import { tailscaleConfigs } from "../src/schema/tailscale-config";
import { outgoingSshConnections } from "./fixtures/ssh-needs-rebind-outgoing";
import { applyPendingMigrations } from "./migration-runner";

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
      // Only this invocation's disposable DB is contracted; no shipped DROP.
      await client.query(
        'ALTER TABLE "ssh_connections" DROP COLUMN "needs_rebind"',
      );
      assert.deepEqual(
        await db.select().from(sshConnections).orderBy(sshConnections.id),
        snapshot,
      );
    }
    assert.deepEqual(
      await db.query.sshConnections.findMany({ orderBy: sshConnections.id }),
      snapshot,
    );
    assert.deepEqual(
      await db
        .select({ needsRebind: sshConnectionNeedsRebind })
        .from(sshCredentials)
        .leftJoin(sshConnections, sql`false`),
      [{ needsRebind: null }],
    );
    for (const transport of [
      "direct",
      "cloudflare_access",
      "tailscale",
    ] as const) {
      const hosts: (typeof sshConnections.$inferSelect)[] = await db
        .insert(sshConnections)
        .values({
          ...owner,
          displayName: `${phase} ${transport}`,
          host: transport === "tailscale" ? "100.64.0.2" : "ssh.example.com",
          port: transport === "cloudflare_access" ? 443 : 22,
          credentialId: credential.id,
          transport,
          cloudflareAccessId:
            transport === "cloudflare_access" ? access.id : null,
          tailscaleId: transport === "tailscale" ? tailscale.id : null,
          generation: 11,
          learnedHostKeyAlgorithm: "ssh-ed25519",
          learnedHostKeyFingerprint: "SHA256:pin",
        })
        .returning();
      const [host] = hosts;
      assert.ok(host);
      const readState = async () => {
        const [row] = await db
          .select({
            transport: sshConnections.transport,
            needsRebind: sshConnectionNeedsRebind,
          })
          .from(sshConnections)
          .where(eq(sshConnections.id, host.id));
        return row;
      };
      assert.deepEqual(await readState(), { transport, needsRebind: false });
      assert.deepEqual(
        await db.query.sshConnections.findFirst({
          where: eq(sshConnections.id, host.id),
        }),
        host,
      );
      const [retained] = await db
        .update(sshConnections)
        .set({ cloudflareAccessId: null, tailscaleId: null })
        .where(eq(sshConnections.id, host.id))
        .returning();
      assert.deepEqual(retained, {
        ...host,
        cloudflareAccessId: null,
        tailscaleId: null,
      });
      assert.deepEqual(await readState(), {
        transport,
        needsRebind: transport !== "direct",
      });
      const [rebound] = await db
        .update(sshConnections)
        .set({
          cloudflareAccessId: host.cloudflareAccessId,
          tailscaleId: host.tailscaleId,
        })
        .where(eq(sshConnections.id, host.id))
        .returning();
      assert.deepEqual(rebound, host);
      assert.deepEqual(await readState(), { transport, needsRebind: false });
      await assert.rejects(
        client.query("DELETE FROM ssh_credentials WHERE id=$1", [
          credential.id,
        ]),
        { code: /^(23503|23001)$/ },
      );
      const [removed] = await db
        .delete(sshConnections)
        .where(eq(sshConnections.id, host.id))
        .returning();
      assert.deepEqual(removed, host);
    }
  }
  console.log(
    "SSH preparation preserves outgoing SQL and canonical runtime behavior with retained/contracted storage",
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
