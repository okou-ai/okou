import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import {
  orgUsageAllowanceEntitlements,
  orgUsageAllowanceWindows,
  usageAllowanceAllocations,
} from "@okouai/db/schema/org-usage-allowance";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { usagePricing } from "@okouai/db/schema/usage-pricing";
import { command } from "ccstate";
import { eq } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { usagePricingResolution$ } from "../context/usage-pricing-resolution";
import { priceUsageEvents } from "./credit-usage-pricing";
import {
  pendingUsageClaimCondition,
  initialSettlementObservation,
  planUsageCharges,
  settledEventValues,
  memberGrantsQuery,
  planMemberGrantDeductions,
  memberGrantDeductionsSql,
  expiryLotsQuery,
  planExpiryLotDeductions,
  expiryLotDeductionsSql,
  settlementDebitValues,
  settlementMetadataQuery,
  completeSettlementReceipt,
  settlementDefaultPlan,
  settlementReceipt,
  pendingUsageRunParentsQuery,
} from "./credit-usage-settlement-plan";
import {
  allowanceEntitlementQuery,
  allowanceAllocationQuery,
  allowanceAnchorQuery,
  planAllowanceCandidates,
  allowanceWindowsQuery,
  planAllowanceWrites,
  allowanceConsumptionSql,
} from "./usage-allowance-settlement-plan";
import { usageEventCompactionLockSql } from "./usage-event-compaction-lock.service";
import {
  orgCreditCompatibilityLockSql,
  prepareUsageAllowanceRefresh$,
} from "./usage-allowance.service";

/** All financial rows commit together; only plain values leave this command. */
export const settleOrgUsage$ = command(
  async ({ get, set }, orgId: string, signal: AbortSignal) => {
    const db = set(writeDb$);
    const resolution = get(usagePricingResolution$);
    const refresh = await set(
      prepareUsageAllowanceRefresh$,
      { orgId, requirePendingUsage: true },
      signal,
    );
    const startedAt = performance.now();
    const work = { ...initialSettlementObservation() };
    const result = await db.transaction(async (tx) => {
      const at = nowDate();
      await tx.execute(usageEventCompactionLockSql("shared"));
      work.lockWaitMs = Math.round(performance.now() - startedAt);
      await tx.execute(orgCreditCompatibilityLockSql(orgId));
      const [metadata] = await tx.select().from(settlementMetadataQuery(orgId));
      const [entitlement] = await tx
        .select()
        .from(allowanceEntitlementQuery(orgId));
      work.orgLockWaitMs =
        Math.round(performance.now() - startedAt) - work.lockWaitMs;
      // Parent ownership precedes usage and its allocation FK rows, matching
      // deletion and compaction. It is compatible with Run status updates.
      const parents = await tx
        .select()
        .from(pendingUsageRunParentsQuery(orgId));
      const events = await tx
        .update(usageEvent)
        .set({ status: "processed", creditsCharged: 0, processedAt: at })
        .where(pendingUsageClaimCondition(orgId, parents))
        .returning();
      work.pendingEvents = events.length;
      const pricing = events.length ? await tx.select().from(usagePricing) : [];
      work.pricingRows = pricing.length;
      const priced = priceUsageEvents(events, pricing, orgId, resolution);
      const allocations = await tx
        .select()
        .from(allowanceAllocationQuery(priced));
      const anchors = await tx
        .select()
        .from(allowanceAnchorQuery(orgId, priced));
      const plan = planAllowanceCandidates(priced, allocations, anchors);
      const windows = await tx
        .select()
        .from(allowanceWindowsQuery(orgId, plan));
      const allowance = planAllowanceWrites({
        orgId,
        plan,
        windows,
        entitlement,
        refresh,
        at,
      });
      if (allowance.entitlementUpdate && entitlement) {
        await tx
          .update(orgUsageAllowanceEntitlements)
          .set(allowance.entitlementUpdate)
          .where(eq(orgUsageAllowanceEntitlements.id, entitlement.id));
      }
      if (allowance.inserted.length) {
        await tx.insert(orgUsageAllowanceWindows).values(allowance.inserted);
      }
      await tx.execute(allowanceConsumptionSql(allowance.changes, at));
      if (allowance.allocations.length) {
        await tx
          .insert(usageAllowanceAllocations)
          .values(allowance.allocations);
      }
      const charges = planUsageCharges(priced, allowance.applied);
      const values = settledEventValues(charges, at);
      await tx
        .update(usageEvent)
        .set(values.values)
        .from(values.source)
        .where(values.condition);
      const grants = await tx
        .select()
        .from(memberGrantsQuery(orgId, charges.byUser, at));
      const deduction = planMemberGrantDeductions(charges.byUser, grants);
      await tx.execute(memberGrantDeductionsSql(deduction.updates));
      work.affectedUsers = charges.byUser.size;
      work.grantRows = grants.length;
      const lots =
        deduction.sharedCredits > 0
          ? await tx.select().from(expiryLotsQuery(orgId))
          : [];
      const expiry = planExpiryLotDeductions(lots, deduction.sharedCredits, at);
      await tx.execute(expiryLotDeductionsSql(expiry.updates));
      work.expiredRows = expiry.expiredRows;
      work.expiryRows = expiry.expiryRows;
      let afterCredits = metadata?.credits ?? 0;
      if (deduction.sharedCredits > 0) {
        await tx
          .insert(orgMetadataCanonicalWrites)
          .values({ orgId, credits: 0 })
          .onConflictDoNothing();
        const [debited] = await tx
          .update(orgMetadata)
          .set(
            settlementDebitValues(deduction.sharedCredits, expiry.expired, at),
          )
          .where(eq(orgMetadata.orgId, orgId))
          .returning();
        if (!debited) {
          throw new Error("Organization debit returned no metadata row");
        }
        const defaultPlan = settlementDefaultPlan(debited);
        if (defaultPlan) {
          await tx
            .insert(orgPlanEntitlements)
            .values(defaultPlan)
            .onConflictDoNothing({ target: orgPlanEntitlements.orgId });
        }
        afterCredits = debited.credits;
      }
      signal.throwIfAborted();
      return settlementReceipt({
        orgId,
        events: priced,
        sharedCredits: deduction.sharedCredits,
        beforeCredits: metadata?.credits ?? 0,
        afterCredits,
        expired: expiry.expired,
        work,
      });
    });
    signal.throwIfAborted();
    return completeSettlementReceipt(result, startedAt);
  },
);
