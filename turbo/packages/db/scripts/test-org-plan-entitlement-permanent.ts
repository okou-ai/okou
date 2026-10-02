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
      console.log(
        "   ✅ Canonical entitlement writes preserve status and explicit package visibility",
      );
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    await client.end();
  }
}
