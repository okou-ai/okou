/**
 * Remaining private org-metadata fixtures tracked under #37440.
 * Their consumers still require scenario-by-scenario deletion or a complete
 * public rewrite; test ownership and public final reads are not exceptions.
 */
import { orgTierSchema } from "@okouai/api-contracts/contracts/orgs";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { createStore } from "ccstate";
import { eq, sql } from "drizzle-orm";

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

/**
 * Repoint the org default Agent.
 *
 * The Clerk org-creation bootstrap is the only writer of
 * `org_metadata.default_agent_id`, so a later default-Agent change — which
 * Morning Brief ownership must survive — has no product path to reproduce.
 */
export async function setOrgDefaultAgentFixture(values: {
  readonly orgId: string;
  readonly agentId: string;
}): Promise<void> {
  const rows = await createStore()
    .set(writeDb$)
    .update(orgMetadata)
    .set({ defaultAgentId: values.agentId, updatedAt: sql`now()` })
    .where(eq(orgMetadata.orgId, values.orgId))
    .returning({ orgId: orgMetadata.orgId });
  if (rows.length !== 1) {
    throw new Error("Expected one org metadata row to repoint");
  }
}
