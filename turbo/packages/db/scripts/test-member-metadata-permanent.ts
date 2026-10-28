import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import { schema } from "../src/index";
import { orgMembersMetadata } from "../src/runtime/org-members-metadata";

/** Current member preference CRUD, implicit RETURNING and root-schema queries. */
export async function validatePermanentMemberMetadata(databaseUrl: string) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const db = drizzle(client, { schema });
  const identity = randomUUID();
  const orgId = `member-metadata-org-${identity}`;
  const userId = `member-metadata-user-${identity}`;
  const owner = and(
    eq(orgMembersMetadata.orgId, orgId),
    eq(orgMembersMetadata.userId, userId),
  );
  const values = { orgId, userId, timezone: "UTC", locale: "en-US" };

  try {
    const [created] = await db
      .insert(orgMembersMetadata)
      .values(values)
      .returning();
    assert.ok(created);
    assert.equal(created.orgId, orgId);
    assert.equal(created.userId, userId);
    assert.equal(created.selectedModel, "auto");
    assert.deepEqual(created.modelSettings, {});
    assert.equal(created.cloudBrowserEnabledByDefault, true);
    assert.equal(created.onboardingDone, false);

    const [upserted] = await db
      .insert(orgMembersMetadata)
      .values(values)
      .onConflictDoUpdate({
        target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
        set: { locale: "zh-Hans" },
      })
      .returning();
    assert.ok(upserted);
    assert.equal(upserted.locale, "zh-Hans");
    assert.equal(upserted.timezone, values.timezone);
    assert.equal(upserted.createdAt.getTime(), created.createdAt.getTime());

    const [selected] = await db.select().from(orgMembersMetadata).where(owner);
    assert.deepEqual(selected, upserted);
    assert.deepEqual(
      await db.query.orgMembersMetadata.findFirst({ where: owner }),
      selected,
    );

    const [updated] = await db
      .update(orgMembersMetadata)
      .set({
        theme: "dark",
        onboardingDone: true,
        cloudBrowserEnabledByDefault: false,
      })
      .where(owner)
      .returning();
    assert.ok(updated);
    assert.equal(updated.theme, "dark");
    assert.equal(updated.onboardingDone, true);
    assert.equal(updated.cloudBrowserEnabledByDefault, false);
    assert.equal(updated.locale, "zh-Hans");
    assert.equal(updated.userId, userId);
    assert.deepEqual(
      await db.query.orgMembersMetadata.findFirst({ where: owner }),
      updated,
    );

    const [deleted] = await db
      .delete(orgMembersMetadata)
      .where(owner)
      .returning();
    assert.deepEqual(deleted, updated);
    assert.equal(
      await db.query.orgMembersMetadata.findFirst({ where: owner }),
      undefined,
    );
    console.log("Current member preference CRUD and root-schema queries work");
  } finally {
    try {
      await db.delete(orgMembersMetadata).where(owner);
    } finally {
      await client.end();
    }
  }
}
