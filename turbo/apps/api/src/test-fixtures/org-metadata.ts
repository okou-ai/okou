/**
 * Remaining private org-metadata fixtures tracked under #37440.
 * Their consumers still require scenario-by-scenario deletion or a complete
 * public rewrite; test ownership and public final reads are not exceptions.
 */
import { orgTierSchema } from "@okouai/api-contracts/contracts/orgs";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { createStore } from "ccstate";
import { sql } from "drizzle-orm";

import { writeDb$ } from "../signals/external/db";
import { upsertOrgPlanEntitlement } from "../signals/services/org-plan-entitlements.service";

export async function upsertOrgMetadataFixture(values: {
  readonly orgId: string;
  readonly tier: string;
  readonly credits: number;
}): Promise<void> {
  const tier = orgTierSchema.parse(values.tier);
  await createStore()
    .set(writeDb$)
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0351; new non-billing transactions are prohibited.
    .transaction(async (tx) => {
      await tx
        .insert(orgMetadataCanonicalWrites)
        .values(values)
        .onConflictDoUpdate({
          target: orgMetadataCanonicalWrites.orgId,
          set: {
            tier: values.tier,
            credits: values.credits,
            updatedAt: sql`now()`,
          },
        });
      await upsertOrgPlanEntitlement(tx, {
        orgId: values.orgId,
        tier,
        source: "org_metadata_migration",
      });
    });
}
