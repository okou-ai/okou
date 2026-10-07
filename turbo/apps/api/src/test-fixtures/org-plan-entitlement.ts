/**
 * Test fixture for the current org plan entitlement snapshot.
 *
 * The snapshot has no public API for constructing deliberately divergent
 * capabilities, so integration tests use this narrow boundary to verify those
 * reads and persisted webhook side effects.
 */
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { writeDb$ } from "../signals/external/db";

export async function upsertOrgPlanEntitlementFixture(values: {
  readonly orgId: string;
  readonly status?: string;
  readonly baseConcurrencyLimit?: number;
  readonly canBuyConcurrency?: boolean;
  readonly canBuyCredits?: boolean;
  readonly showUsagePack?: boolean;
  readonly autoRechargeAllowed?: boolean;
  readonly restrictedBuiltInModels?: boolean;
  readonly workflowWebhookAutomationAllowed?: boolean;
  readonly audioLifetimeLimit?: number | null;
  readonly audioDailyRateLimit?: number;
  readonly audioDailyDurationSeconds?: number;
}): Promise<void> {
  const row = {
    orgId: values.orgId,
    planKey: "test-fixture",
    planRank: 0,
    source: "test_fixture",
    status: values.status ?? "active",
    baseConcurrencyLimit: values.baseConcurrencyLimit ?? 0,
    canBuyConcurrency: values.canBuyConcurrency,
    canBuyCredits: values.canBuyCredits,
    showUsagePack: values.showUsagePack,
    autoRechargeAllowed: values.autoRechargeAllowed,
    restrictedBuiltInModels: values.restrictedBuiltInModels,
    workflowWebhookTriggerAllowed: values.workflowWebhookAutomationAllowed,
    audioLifetimeLimit: values.audioLifetimeLimit,
    audioDailyRateLimit: values.audioDailyRateLimit,
    audioDailyDurationSeconds: values.audioDailyDurationSeconds,
  };
  await createStore()
    .set(writeDb$)
    .insert(orgPlanEntitlements)
    .values({
      ...row,
      // Preserve the fixture's prior insert behavior without relying on a
      // database default for the now-required canonical column.
      restrictedBuiltInModels: row.restrictedBuiltInModels ?? true,
    })
    .onConflictDoUpdate({
      target: orgPlanEntitlements.orgId,
      set: {
        planKey: row.planKey,
        planRank: row.planRank,
        source: row.source,
        status: row.status,
        baseConcurrencyLimit: row.baseConcurrencyLimit,
        ...(row.canBuyConcurrency === undefined
          ? {}
          : { canBuyConcurrency: row.canBuyConcurrency }),
        ...(row.canBuyCredits === undefined
          ? {}
          : { canBuyCredits: row.canBuyCredits }),
        ...(row.showUsagePack === undefined
          ? {}
          : {
              showUsagePack: row.showUsagePack,
            }),
        ...(row.autoRechargeAllowed === undefined
          ? {}
          : { autoRechargeAllowed: row.autoRechargeAllowed }),
        ...(row.restrictedBuiltInModels === undefined
          ? {}
          : { restrictedBuiltInModels: row.restrictedBuiltInModels }),
        ...(row.workflowWebhookTriggerAllowed === undefined
          ? {}
          : {
              workflowWebhookTriggerAllowed: row.workflowWebhookTriggerAllowed,
            }),
        ...(row.audioLifetimeLimit === undefined
          ? {}
          : { audioLifetimeLimit: row.audioLifetimeLimit }),
        ...(row.audioDailyRateLimit === undefined
          ? {}
          : { audioDailyRateLimit: row.audioDailyRateLimit }),
        ...(row.audioDailyDurationSeconds === undefined
          ? {}
          : { audioDailyDurationSeconds: row.audioDailyDurationSeconds }),
      },
    });
}

export async function deleteOrgPlanEntitlementFixture(
  orgId: string,
): Promise<void> {
  await createStore()
    .set(writeDb$)
    .delete(orgPlanEntitlements)
    .where(eq(orgPlanEntitlements.orgId, orgId));
}
