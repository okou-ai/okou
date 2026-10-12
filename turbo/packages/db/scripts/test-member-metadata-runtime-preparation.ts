import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { z } from "zod";

import { schema } from "../src/index";
import { orgMembersMetadata } from "../src/runtime/org-members-metadata";

/** Retain through physical contraction, then promote current preference CRUD. */
export async function validateMemberMetadataRuntimePreparation(
  databaseUrl: string,
) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const db = drizzle(client, { schema });
  const namespace = `member_runtime_${randomUUID().replaceAll("-", "")}`;
  try {
    // Only this owned clone changes; the replayed/generated public schema stays intact.
    await client.query(`CREATE SCHEMA "${namespace}"`);
    await client.query(
      `CREATE TABLE "${namespace}"."org_members_metadata" (LIKE public.org_members_metadata INCLUDING ALL)`,
    );
    // Keep both physical shapes available until contraction is accepted in production.
    await client.query(
      `ALTER TABLE "${namespace}"."org_members_metadata" ADD COLUMN IF NOT EXISTS morning_brief_collection_revoked_at timestamp`,
    );
    await client.query(`SET search_path TO "${namespace}", public`);

    for (const phase of ["before", "after"] as const) {
      if (phase === "after") {
        await client.query(
          `ALTER TABLE "${namespace}"."org_members_metadata" DROP COLUMN morning_brief_collection_revoked_at RESTRICT`,
        );
      }
      const orgId = `org-${namespace}`;
      const userId = `member-${phase}-${namespace}`;
      const owner = and(
        eq(orgMembersMetadata.orgId, orgId),
        eq(orgMembersMetadata.userId, userId),
      );
      const values = { orgId, userId, timezone: "UTC", locale: "en-US" };
      const [created] = await db
        .insert(orgMembersMetadata)
        .values(values)
        .returning();
      assert.equal(created?.orgId, orgId);
      assert.equal(created?.userId, userId);
      assert.equal(created?.selectedModel, "auto");
      assert.deepEqual(created?.modelSettings, {});
      assert.equal(created?.cloudBrowserEnabledByDefault, true);
      assert.equal(created?.onboardingDone, false);

      if (phase === "before") {
        await client.query(
          `UPDATE "${namespace}"."org_members_metadata" SET morning_brief_collection_revoked_at = '2026-03-10T00:00:00' WHERE org_id = $1 AND user_id = $2`,
          [orgId, userId],
        );
      }
      const [upserted] = await db
        .insert(orgMembersMetadata)
        .values(values)
        .onConflictDoUpdate({
          target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
          set: { locale: "zh-Hans" },
        })
        .returning();
      assert.equal(upserted?.locale, "zh-Hans");
      assert.equal(upserted?.timezone, values.timezone);
      assert.equal(upserted?.createdAt.getTime(), created?.createdAt.getTime());
      if (phase === "before") {
        const retained = await client.query(
          `SELECT morning_brief_collection_revoked_at IS NOT NULL AS retained FROM "${namespace}"."org_members_metadata" WHERE org_id = $1 AND user_id = $2`,
          [orgId, userId],
        );
        assert.deepEqual(
          z.array(z.object({ retained: z.boolean() })).parse(retained.rows),
          [{ retained: true }],
        );
      }

      const [selected] = await db
        .select()
        .from(orgMembersMetadata)
        .where(owner);
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
      assert.equal(updated?.theme, "dark");
      assert.equal(updated?.onboardingDone, true);
      assert.equal(updated?.cloudBrowserEnabledByDefault, false);
      assert.equal(updated?.locale, "zh-Hans");
      assert.equal(updated?.userId, userId);

      const [deleted] = await db
        .delete(orgMembersMetadata)
        .where(owner)
        .returning();
      assert.deepEqual(deleted, updated);
      assert.equal(
        await db.query.orgMembersMetadata.findFirst({ where: owner }),
        undefined,
      );
    }
    console.log(
      "Member preference SQL and root-schema reads work before and after fence contraction",
    );
  } finally {
    try {
      await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    } finally {
      await client.end();
    }
  }
}
