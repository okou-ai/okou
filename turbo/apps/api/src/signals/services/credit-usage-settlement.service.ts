import { socialDataJobs } from "@okouai/db/schema/social-data-job";
import {
  managedRunQuery,
  managedValues,
  receiptQuery,
} from "./managed-usage-record";
import {
  socialJobQuery,
  socialClaimUnavailable,
  socialUsageArgs,
  socialWhere,
  socialValues,
  type SocialSettlementClaim,
} from "./social-data-settlement-plan";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { usagePricing } from "@okouai/db/schema/usage-pricing";
import { command } from "ccstate";
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
  orgDebitPlan,
  walletQuery,
  completeSettlementReceipt,
  settlementDefaultPlan,
  settlementReceipt,
  pendingParentsQuery,
} from "./credit-usage-settlement-plan";
import {
  entitlementQuery,
  allocationQuery,
  anchorQuery,
  planAllowanceCandidates,
  windowQuery,
  planAllowanceWrites,
} from "./usage-allowance-settlement-plan";
import { usageEventCompactionLockSql } from "./usage-event-compaction-lock.service";
import {
  orgCreditCompatibilityLockSql,
  type PreparedUsageAllowanceRefresh,
} from "./usage-allowance.service";

interface UsageSettlementArgs {
  readonly orgId: string;
  readonly refresh?: PreparedUsageAllowanceRefresh;
  readonly social?: SocialSettlementClaim;
}

/** All financial rows commit together; only plain values leave this command. */
export const settleOrgUsage$ = command(
  async ({ get, set }, args: UsageSettlementArgs, signal: AbortSignal) => {
    const { orgId, refresh } = args;
    const db = set(writeDb$);
    const resolution = get(usagePricingResolution$);
    const startedAt = performance.now();
    const work = { ...initialSettlementObservation() };
    const result = await db.transaction(async (tx) => {
      const at = nowDate();
      await tx.execute(usageEventCompactionLockSql("shared"));
      work.lockWaitMs = Math.round(performance.now() - startedAt);
      const [job] = args.social
        ? await tx.select().from(socialJobQuery(orgId, args.social))
        : [];
      if (socialClaimUnavailable(args.social, job)) {
        return null;
      }
      const managed = socialUsageArgs(job);
      await tx.execute(orgCreditCompatibilityLockSql(orgId));
      const [run] = managed
        ? await tx.select().from(managedRunQuery(managed))
        : [];
      if (managed) {
        await tx
          .insert(usageEvent)
          .values(managedValues(managed, run))
          .onConflictDoNothing({ target: usageEvent.idempotencyKey });
      }
      const [wallet] = await tx.select().from(walletQuery(orgId));
      const [entitlement] = await tx.select().from(entitlementQuery(orgId));
      work.orgLockWaitMs =
        Math.round(performance.now() - startedAt) - work.lockWaitMs;
      // Parent ownership precedes usage and its allocation FK rows, matching
      // deletion and compaction. It is compatible with Run status updates.
      const parents = await tx.select().from(pendingParentsQuery(orgId));
      const events =
        !job || managed
          ? await tx
              .update(usageEvent)
              .set({ status: "processed", creditsCharged: 0, processedAt: at })
              .where(pendingUsageClaimCondition(orgId, parents))
              .returning()
          : [];
      work.pendingEvents = events.length;
      const pricing = events.length ? await tx.select().from(usagePricing) : [];
      work.pricingRows = pricing.length;
      const priced = priceUsageEvents(events, pricing, orgId, resolution);
      const allocations = await tx.select().from(allocationQuery(priced));
      const anchors = await tx.select().from(anchorQuery(orgId, priced));
      const plan = planAllowanceCandidates(priced, allocations, anchors);
      const windows = await tx.select().from(windowQuery(orgId, plan));
      const scope = { orgId, refresh, at };
      const allowance = planAllowanceWrites(scope, plan, windows, entitlement);
      for (const mutation of allowance.mutations) {
        await tx.execute(mutation);
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
      let afterCredits = wallet?.credits ?? 0;
      if (deduction.sharedCredits > 0) {
        const debit = orgDebitPlan(
          orgId,
          deduction.sharedCredits,
          expiry.expired,
          at,
        );
        const [debited] = await tx
          .insert(orgMetadataCanonicalWrites)
          .values(debit.values)
          .onConflictDoUpdate(debit.conflict)
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
      if (args.social && job) {
        const [receipt] = managed
          ? await tx.select().from(receiptQuery(job.usageIdempotencyKey))
          : [];
        await tx
          .update(socialDataJobs)
          .set(socialValues(managed, receipt, at))
          .where(socialWhere(args.social));
      }
      signal.throwIfAborted();
      return settlementReceipt({
        orgId,
        events: priced,
        sharedCredits: deduction.sharedCredits,
        beforeCredits: wallet?.credits ?? 0,
        afterCredits,
        expired: expiry.expired,
        work,
      });
    });
    signal.throwIfAborted();
    return result ? completeSettlementReceipt(result, startedAt) : null;
  },
);
