import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { orgPlanEntitlements } from "../src/runtime/org-plan-entitlement";

// Exercise the runtime projection against both replayed and regenerated schemas.
// This contract does not depend on a historical migration or an outgoing API.
export async function validatePermanentOrgPlanEntitlementState(
  databaseUrl: string,
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    try {
      const db = drizzle(client);
      for (const source of [
        "stripe_subscription",
        "stripe_atom_grant",
        "org_metadata_bootstrap",
        "org_metadata_migration",
      ]) {
        const orgId = `entitlement_${randomUUID()}`;
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
      for (const [statement, constraint] of [
        [
          `INSERT INTO org_metadata (org_id, tier) VALUES ('retired_free_metadata', 'free')`,
          "chk_org_metadata_tier_not_free",
        ],
        [
          `INSERT INTO org_metadata (org_id, pending_subscription_target_tier) VALUES ('retired_free_pending', 'free')`,
          "chk_org_metadata_pending_target_not_free",
        ],
        [
          `INSERT INTO org_plan_entitlements (org_id, plan_key, plan_rank, source, restricted_built_in_models) VALUES ('retired_free_entitlement', 'free', 0, 'manual', true)`,
          "chk_org_plan_entitlements_plan_key_not_free",
        ],
      ] as const) {
        await client.query("SAVEPOINT retired_free_rejected");
        try {
          await assert.rejects(client.query(statement), (error: unknown) => {
            return (
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "23514" &&
              "constraint" in error &&
              error.constraint === constraint
            );
          });
        } finally {
          await client.query("ROLLBACK TO SAVEPOINT retired_free_rejected");
          await client.query("RELEASE SAVEPOINT retired_free_rejected");
        }
      }
      console.log(
        "   ✅ Canonical entitlement writes preserve status and package visibility; retired Free writes are rejected",
      );
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    await client.end();
  }
}
