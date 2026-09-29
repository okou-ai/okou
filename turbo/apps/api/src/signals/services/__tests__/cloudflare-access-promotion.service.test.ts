import { randomUUID } from "node:crypto";

import { cloudflareAccessConfigs } from "@okouai/db/schema/cloudflare-access-config";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { expect, onTestFinished, test } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import { settle } from "../../utils";
import { convertCloudflareAccessToOrganization } from "../cloudflare-access.service";

testContext();

// A retained different-owner Personal binding is impossible through the product
// API while the legacy trigger exists. Use a private real-DB schema with the
// same-org FK and no triggers, never a corrupt row in the shared route database.
async function createHarness() {
  const schema = `access_promotion_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({
    connectionString: env("DATABASE_URL"),
    max: 1,
    allowExitOnIdle: true,
  });
  const pool = new Pool({
    connectionString: env("DATABASE_URL"),
    max: 2,
    allowExitOnIdle: true,
    options: `-c search_path=${schema},public -c statement_timeout=10000`,
  });
  const admin = drizzle(adminPool);
  const db = drizzle(pool);
  const destroy = async () => {
    const poolClosed = await settle(pool.end());
    const schemaDropped = await settle(
      admin.execute(
        sql`DROP SCHEMA IF EXISTS ${sql.identifier(schema)} CASCADE`,
      ),
    );
    const adminClosed = await settle(adminPool.end());
    for (const result of [poolClosed, schemaDropped, adminClosed]) {
      if (!result.ok) {
        throw result.error;
      }
    }
  };
  const initialized = await settle(
    (async () => {
      await admin.execute(sql`CREATE SCHEMA ${sql.identifier(schema)}`);
      await db.execute(sql`
        CREATE TABLE cloudflare_access_configs
        (LIKE public.cloudflare_access_configs INCLUDING ALL)
      `);
      await db.execute(sql`
        CREATE TABLE ssh_connections (LIKE public.ssh_connections INCLUDING ALL)
      `);
      await db.execute(sql`
        ALTER TABLE ssh_connections
        ADD CONSTRAINT ssh_connections_cloudflare_access_org_fk
        FOREIGN KEY (cloudflare_access_id, org_id)
        REFERENCES cloudflare_access_configs (id, org_id) ON DELETE RESTRICT
      `);
    })(),
  );
  if (!initialized.ok) {
    await destroy();
    throw initialized.error;
  }
  return { db, destroy };
}

test("promotion rejects a retained reference from another owner without changing bindings", async () => {
  const { db, destroy } = await createHarness();
  onTestFinished(destroy);
  const owner = {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
    orgRole: "admin" as const,
  };
  const configId = randomUUID();
  const ownHostId = randomUUID();
  const otherHostId = randomUUID();
  await db.insert(cloudflareAccessConfigs).values({
    id: configId,
    orgId: owner.orgId,
    userId: owner.userId,
    scope: "personal",
    name: "Protected config",
    encryptedClientId: "encrypted-id",
    encryptedClientSecret: "encrypted-secret",
  });
  await db.insert(sshConnections).values([
    {
      id: ownHostId,
      orgId: owner.orgId,
      userId: owner.userId,
      displayName: "Owner host",
      host: "owner.example.com",
      port: 443,
      credentialId: randomUUID(),
      cloudflareAccessId: configId,
    },
    {
      id: otherHostId,
      orgId: owner.orgId,
      userId: `other_${randomUUID()}`,
      displayName: "Retained other-owner host",
      host: "other.example.com",
      port: 443,
      credentialId: randomUUID(),
      cloudflareAccessId: configId,
    },
  ]);

  const result = await convertCloudflareAccessToOrganization({
    db,
    owner,
    configId,
    expectedRevision: 1,
  });
  expect(result).toMatchObject({
    ok: false,
    kind: "conflict",
    code: "CLOUDFLARE_ACCESS_IN_USE",
  });
  await expect(
    db
      .select({
        scope: cloudflareAccessConfigs.scope,
        userId: cloudflareAccessConfigs.userId,
        revision: cloudflareAccessConfigs.revision,
      })
      .from(cloudflareAccessConfigs)
      .where(eq(cloudflareAccessConfigs.id, configId)),
  ).resolves.toStrictEqual([
    { scope: "personal", userId: owner.userId, revision: 1 },
  ]);
  await expect(
    db
      .select({
        id: sshConnections.id,
        accessId: sshConnections.cloudflareAccessId,
        generation: sshConnections.generation,
      })
      .from(sshConnections)
      .where(eq(sshConnections.cloudflareAccessId, configId))
      .orderBy(asc(sshConnections.id)),
  ).resolves.toStrictEqual(
    [
      { id: ownHostId, accessId: configId, generation: 1 },
      { id: otherHostId, accessId: configId, generation: 1 },
    ].sort((a, b) => {
      return a.id.localeCompare(b.id);
    }),
  );
});
