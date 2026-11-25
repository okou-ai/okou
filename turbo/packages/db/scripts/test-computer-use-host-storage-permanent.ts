import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import { schema } from "../src/index";
import { computerUseHosts } from "../src/runtime/computer-use-host";
import { computerUseHosts as physicalHosts } from "../src/schema/computer-use-host";
import { remoteDevices } from "../src/schema/remote-device";

/** Current host storage contract on replayed and freshly generated schemas. */
export async function validatePermanentComputerUseHostStorage(
  databaseUrl: string,
) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const db = drizzle(client, { schema });
  const orgId = `host-storage-${randomUUID()}`;
  const installationId = randomUUID();
  const values = {
    orgId,
    userId: "host-storage-owner",
    installationId,
    displayName: "Session installation",
    sessionId: "sess_host_storage",
    appVersion: "0.52.1",
    osVersion: "15.0",
  };
  try {
    assert.deepEqual(
      (
        await client.query(`SELECT attname FROM pg_catalog.pg_attribute
        WHERE attrelid = 'public.computer_use_hosts'::regclass
          AND attname = 'token_hash' AND NOT attisdropped`)
      ).rows,
      [],
      "The retired host credential must be physically absent",
    );
    assert.equal(
      (
        await client.query(
          `SELECT to_regclass('public.idx_computer_use_hosts_token_hash') AS name`,
        )
      ).rows[0]?.name,
      null,
    );
    const [device] = await db
      .insert(remoteDevices)
      .values({ orgId, userId: values.userId, displayName: values.displayName })
      .returning();
    assert.ok(device);
    assert.equal(device.accessAllowed, false);
    assert.equal(device.accessExpiresAt, null);
    const [created] = await db
      .insert(computerUseHosts)
      .values({ ...values, remoteDeviceId: device.id })
      .returning();
    assert.ok(created);
    assert.equal(created.connectionGeneration, 0);
    assert.equal(created.status, "online");
    const [destination] = await db
      .insert(remoteDevices)
      .values({
        orgId,
        userId: values.userId,
        displayName: "Destination",
        accessAllowed: true,
      })
      .returning({ id: remoteDevices.id });
    assert.ok(destination);
    await db
      .update(computerUseHosts)
      .set({ remoteDeviceId: destination.id })
      .where(eq(computerUseHosts.id, created.id));

    const [reconnected] = await db
      .insert(computerUseHosts)
      .values(values)
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
          sessionId: "sess_reconnected",
          connectionGeneration: sql`${computerUseHosts.connectionGeneration} + 1`,
        },
      })
      .returning();
    assert.equal(reconnected?.id, created.id);
    assert.equal(reconnected?.connectionGeneration, 1);
    assert.equal(reconnected?.sessionId, "sess_reconnected");
    assert.equal(reconnected?.remoteDeviceId, destination.id);
    assert.deepEqual(reconnected?.createdAt, created.createdAt);
    assert.equal(
      (
        await db
          .select()
          .from(remoteDevices)
          .where(eq(remoteDevices.orgId, orgId))
      ).length,
      2,
      "A move must preserve both device records",
    );
    assert.deepEqual(
      await db.query.computerUseHosts.findFirst({
        where: eq(computerUseHosts.id, created.id),
      }),
      reconnected,
    );
    assert.deepEqual(
      await db
        .select()
        .from(physicalHosts)
        .where(eq(physicalHosts.id, created.id)),
      [reconnected],
      "Both exported mappings must generate legal current SQL",
    );

    const [otherOwner] = await db
      .insert(computerUseHosts)
      .values({ ...values, userId: "another-owner" })
      .returning();
    assert.ok(otherOwner);
    assert.notEqual(
      otherOwner.id,
      created.id,
      "Installation identity is scoped to its owner",
    );
    const [revoked] = await db
      .update(computerUseHosts)
      .set({ status: "offline", revokedAt: new Date() })
      .where(eq(computerUseHosts.id, created.id))
      .returning();
    assert.equal(revoked?.status, "offline");
    assert.equal(revoked?.connectionGeneration, 1);
    const [replacement] = await db
      .insert(computerUseHosts)
      .values(values)
      .returning();
    assert.ok(replacement);
    assert.notEqual(
      replacement.id,
      created.id,
      "Revoked hosts must not occupy the active installation key",
    );
    assert.deepEqual(
      await db.query.computerUseHosts.findFirst({
        where: eq(computerUseHosts.id, created.id),
      }),
      revoked,
      "A replacement must preserve the historical revoked host",
    );
    console.log(
      "Current host storage preserves installation identity, session generations and revoked history",
    );
  } finally {
    try {
      await db
        .delete(computerUseHosts)
        .where(eq(computerUseHosts.orgId, orgId));
      await db.delete(remoteDevices).where(eq(remoteDevices.orgId, orgId));
    } finally {
      await client.end();
    }
  }
}
