import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import { schema } from "../src/index";
import {
  sshConnections,
  sshConnectionNeedsRebind,
} from "../src/runtime/ssh-connection";
import { sshConnections as physicalSshConnections } from "../src/schema/ssh-connection";
import { sshCredentials } from "../src/schema/ssh-credential";
import { cloudflareAccessConfigs } from "../src/schema/cloudflare-access-config";
import { tailscaleConfigs } from "../src/schema/tailscale-config";

/** Canonical SQL, ownership and binding state on replayed and fresh schemas. */
export async function validatePermanentSshStorage(databaseUrl: string) {
  const client = new Client({ connectionString: databaseUrl });
  const db = drizzle(client, { schema });
  const owner = { orgId: `ssh-storage-${randomUUID()}`, userId: "ssh-owner" };
  let connected = false;
  try {
    await client.connect();
    connected = true;
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
    assert.ok(credential && access && tailscale);
    assert.deepEqual(
      await db
        .select({ needsRebind: sshConnectionNeedsRebind })
        .from(sshCredentials)
        .leftJoin(sshConnections, sql`false`)
        .where(eq(sshCredentials.id, credential.id)),
      [{ needsRebind: null }],
    );
    for (const connectionMode of [
      "direct",
      "cloudflare_access",
      "tailscale",
    ] as const) {
      const hosts: (typeof sshConnections.$inferSelect)[] = await db
        .insert(sshConnections)
        .values({
          ...owner,
          displayName: `Canonical ${connectionMode}`,
          host:
            connectionMode === "tailscale" ? "100.64.0.2" : "ssh.example.com",
          port: connectionMode === "cloudflare_access" ? 443 : 22,
          credentialId: credential.id,
          connectionMode,
          cloudflareAccessId:
            connectionMode === "cloudflare_access" ? access.id : null,
          tailscaleId: connectionMode === "tailscale" ? tailscale.id : null,
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
            connectionMode: sshConnections.connectionMode,
            needsRebind: sshConnectionNeedsRebind,
          })
          .from(sshConnections)
          .where(eq(sshConnections.id, host.id));
        return row;
      };
      assert.deepEqual(await readState(), {
        connectionMode,
        needsRebind: false,
      });
      assert.deepEqual(
        await db.query.sshConnections.findFirst({
          where: eq(sshConnections.id, host.id),
        }),
        host,
      );
      assert.deepEqual(
        await db
          .select()
          .from(physicalSshConnections)
          .where(eq(physicalSshConnections.id, host.id)),
        [host],
        "The physical mapping must issue the same canonical SQL",
      );
      await assert.rejects(
        client.query("UPDATE ssh_connections SET user_id=$1 WHERE id=$2", [
          "another-owner",
          host.id,
        ]),
        { code: "23503", constraint: "ssh_connections_credential_owner_fk" },
      );
      await assert.rejects(
        client.query(
          "UPDATE ssh_connections SET transport='direct',cloudflare_access_id=$1 WHERE id=$2",
          [access.id, host.id],
        ),
        { code: "23514", constraint: "chk_ssh_connections_transport_binding" },
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
        connectionMode,
        needsRebind: connectionMode !== "direct",
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
      assert.deepEqual(await readState(), {
        connectionMode,
        needsRebind: false,
      });
      await assert.rejects(
        client.query("DELETE FROM ssh_credentials WHERE id=$1", [
          credential.id,
        ]),
        {
          code: /^(23503|23001)$/,
          constraint: "ssh_connections_credential_owner_fk",
        },
      );
      const [removed] = await db
        .delete(sshConnections)
        .where(eq(sshConnections.id, host.id))
        .returning();
      assert.deepEqual(removed, host);
    }
    const [identity] = await db
      .insert(sshConnections)
      .values({
        ...owner,
        displayName: "Tailscale identity",
        host: "100.64.0.2",
        port: 22,
        connectionMode: "tailscale_ssh",
        tailscaleId: tailscale.id,
        tailscaleSshUsername: "ubuntu",
      })
      .returning();
    assert.ok(identity);
    assert.equal(identity.credentialId, null);
    for (const change of [
      "port=2222",
      "tailscale_ssh_username=NULL",
      "tailscale_ssh_username=' '",
      "transport='tailscale'",
      `credential_id='${credential.id}'`,
    ]) {
      await assert.rejects(
        client.query(`UPDATE ssh_connections SET ${change} WHERE id=$1`, [
          identity.id,
        ]),
        { code: "23514", constraint: "chk_ssh_connections_login" },
      );
    }
    await db
      .update(sshConnections)
      .set({ tailscaleId: null })
      .where(eq(sshConnections.id, identity.id));
    assert.deepEqual(
      await db
        .select({
          connectionMode: sshConnections.connectionMode,
          needsRebind: sshConnectionNeedsRebind,
        })
        .from(sshConnections)
        .where(eq(sshConnections.id, identity.id)),
      [{ connectionMode: "tailscale_ssh", needsRebind: true }],
    );
  } finally {
    try {
      if (connected) {
        await db
          .delete(sshConnections)
          .where(eq(sshConnections.orgId, owner.orgId));
        await db
          .delete(cloudflareAccessConfigs)
          .where(eq(cloudflareAccessConfigs.orgId, owner.orgId));
        await db
          .delete(tailscaleConfigs)
          .where(eq(tailscaleConfigs.orgId, owner.orgId));
        await db
          .delete(sshCredentials)
          .where(eq(sshCredentials.orgId, owner.orgId));
      }
    } finally {
      await client.end();
    }
  }
}
