import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { orgPlanEntitlements } from "../src/runtime/org-plan-entitlement";
import { orgMetadata } from "../src/schema/org-metadata";

// Exercise the runtime projection against both replayed and regenerated schemas.
// This contract does not depend on a historical migration or an outgoing API.
export async function validatePermanentOrgPlanEntitlementState(
  databaseUrl: string,
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const db = drizzle(client);
    const orgIds: string[] = [];
    try {
      for (const source of [
        "stripe_subscription",
        "stripe_atom_grant",
        "org_metadata_bootstrap",
        "org_metadata_migration",
      ]) {
        const orgId = `entitlement_${randomUUID()}`;
        orgIds.push(orgId);
        for (const state of [
          { status: "active", showUsagePack: true },
          { status: "suspended", showUsagePack: false },
          { status: "active", showUsagePack: false },
          { status: "active", showUsagePack: true },
        ]) {
          const [written] = await db
            .insert(orgPlanEntitlements)
            .values({
              orgId,
              planKey: "pro",
              planRank: 1,
              source,
              baseConcurrencyLimit: 7,
              canBuyCredits: true,
              restrictedBuiltInModels: false,
              ...state,
            })
            .onConflictDoUpdate({
              target: orgPlanEntitlements.orgId,
              set: state,
            })
            .returning();
          assert.ok(written);
          const rows = await db
            .select()
            .from(orgPlanEntitlements)
            .where(eq(orgPlanEntitlements.orgId, orgId));
          assert.deepEqual(rows, [written]);
          assert.equal(written.status, state.status);
          assert.equal(written.showUsagePack, state.showUsagePack);
          assert.equal(written.source, source);
          assert.equal(written.baseConcurrencyLimit, 7);
        }
      }
      console.log(
        "   ✅ Canonical entitlement writes preserve status and explicit package visibility",
      );

      const guardedOrgId = `plan_fence_${randomUUID()}`;
      const rejectedOrgId = `rejected_plan_${randomUUID()}`;
      orgIds.push(guardedOrgId, rejectedOrgId);
      const [metadata] = await db
        .insert(orgMetadata)
        .values({ orgId: guardedOrgId, tier: "team", credits: 246 })
        .returning();
      const [entitlement] = await db
        .insert(orgPlanEntitlements)
        .values({
          orgId: guardedOrgId,
          planKey: "team",
          planRank: 2,
          source: "stripe_atom_grant",
          baseConcurrencyLimit: 10,
          restrictedBuiltInModels: false,
          expiresAt: new Date("2027-01-01T00:00:00Z"),
        })
        .returning();

      // The database boundary also applies to an invocation of an older API.
      await assert.rejects(
        client.query(
          "INSERT INTO org_metadata (org_id,tier) VALUES ($1,'custom')",
          [rejectedOrgId],
        ),
        { code: "23514", constraint: "chk_org_metadata_tier_not_custom" },
      );
      await assert.rejects(
        client.query("UPDATE org_metadata SET tier='custom' WHERE org_id=$1", [
          guardedOrgId,
        ]),
        { code: "23514", constraint: "chk_org_metadata_tier_not_custom" },
      );
      await assert.rejects(
        client.query(
          "INSERT INTO org_metadata (org_id,pending_subscription_target_tier) VALUES ($1,'custom')",
          [rejectedOrgId],
        ),
        {
          code: "23514",
          constraint: "chk_org_metadata_pending_target_not_custom",
        },
      );
      await assert.rejects(
        client.query(
          "UPDATE org_metadata SET pending_subscription_target_tier='custom' WHERE org_id=$1",
          [guardedOrgId],
        ),
        {
          code: "23514",
          constraint: "chk_org_metadata_pending_target_not_custom",
        },
      );
      await assert.rejects(
        client.query(
          "INSERT INTO org_plan_entitlements (org_id,plan_key,plan_rank,source,restricted_built_in_models) VALUES ($1,'custom',3,'stripe_atom_grant',false)",
          [rejectedOrgId],
        ),
        {
          code: "23514",
          constraint: "chk_org_plan_entitlements_plan_key_not_custom",
        },
      );
      await assert.rejects(
        client.query(
          "UPDATE org_plan_entitlements SET plan_key='custom' WHERE org_id=$1",
          [guardedOrgId],
        ),
        {
          code: "23514",
          constraint: "chk_org_plan_entitlements_plan_key_not_custom",
        },
      );
      assert.deepEqual(
        await db
          .select()
          .from(orgMetadata)
          .where(eq(orgMetadata.orgId, guardedOrgId)),
        [metadata],
      );
      assert.deepEqual(
        await db
          .select()
          .from(orgPlanEntitlements)
          .where(eq(orgPlanEntitlements.orgId, guardedOrgId)),
        [entitlement],
      );
      console.log(
        "   ✅ Custom write fences preserve existing balances and Atom expiry",
      );
    } finally {
      await db
        .delete(orgPlanEntitlements)
        .where(inArray(orgPlanEntitlements.orgId, orgIds));
      await db.delete(orgMetadata).where(inArray(orgMetadata.orgId, orgIds));
    }
  } finally {
    await client.end();
  }
}
