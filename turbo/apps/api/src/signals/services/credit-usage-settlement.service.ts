import {
  usageExpiryScope,
  expiryLotsQuery,
  unseenExpiryQuery,
  planCurrentExpiryDeduction,
} from "./usage-expiry-prefix";
import {
  preparedMemberGrantsQuery,
  requiredUsageGrantPrefix,
  unseenGrantPrefixQuery,
  requireCurrentGrantPrefix,
} from "./usage-grant-prefix";
import { settle } from "../utils";
import { prepareUsageSettlementBatch$ } from "./credit-usage-batch-prepare.service";
import {
  requireCompleteUsageClaim,
  UsageSettlementSnapshotConflict,
  requiredSettlementDebit,
  type PreparedUsageBatch,
  preparedSettlementPrices,
  reportCommittedSettlementPricing,
  requireSettlementPricingSnapshot,
  settlementPricingQuery,
} from "./credit-usage-batch";
import { socialDataJobs } from "@okouai/db/schema/social-data-job";
import {
  managedRunQuery,
  managedValues,
  receiptQuery,
} from "./managed-usage-record";
import {
  socialJobQuery,
  socialClaimUnavailable,
  checkedSocialSettlementPlan,
  socialWhere,
  socialValues,
  type SocialSettlementClaim,
} from "./social-data-settlement-plan";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { command } from "ccstate";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { usagePricingResolution$ } from "../context/usage-pricing-resolution";
import {
  claimUsageWhere,
  initialSettlementObservation,
  emptySettlementReceipt,
  hasNoStandaloneUsage,
  planUsageCharges,
  settledEventsSql,
  planMemberGrantDeductions,
  memberGrantDeductionsSql,
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
  readonly idempotencyKeys?: readonly string[];
  readonly refresh?: PreparedUsageAllowanceRefresh;
  readonly social?: SocialSettlementClaim;
}

interface SettlementBatchArgs extends UsageSettlementArgs {
  readonly batch: PreparedUsageBatch;
}

/** All financial rows commit together; only plain values leave this command. */
const commitUsageBatch$ = command(
  async ({ set }, args: SettlementBatchArgs, signal: AbortSignal) => {
    const { orgId, refresh, batch } = args;
    const db = set(writeDb$);
    const startedAt = performance.now();
    const work = { ...initialSettlementObservation() };
    const result = await db.transaction(async (tx) => {
      await tx.execute(usageEventCompactionLockSql("shared"));
      work.lockWaitMs = Math.round(performance.now() - startedAt);
      const [job] = args.social
        ? await tx.select().from(socialJobQuery(orgId, args.social))
        : [];
      if (socialClaimUnavailable(args.social, job)) {
        return null;
      }
      const social = checkedSocialSettlementPlan(batch.social, job);
      const managed = social.usage;
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
      // Parent ownership precedes usage and its allocation FK rows, matching
      // deletion, launch activation and compaction. Own parents before the
      // entitlement as well: launch and cleanup can already own those Runs.
      const key = managed?.idempotencyKey;
      const parents = await tx
        .select()
        .from(pendingParentsQuery(orgId, batch.events, key));
      const [wallet] = await tx.select().from(walletQuery(orgId));
      const [entitlement] = await tx.select().from(entitlementQuery(orgId));
      const at = nowDate();
      work.orgLockWaitMs =
        Math.round(performance.now() - startedAt) - work.lockWaitMs;
      const events = social.processPending
        ? await tx
            .update(usageEvent)
            .set({ status: "processed", creditsCharged: 0, processedAt: at })
            .where(claimUsageWhere(orgId, parents, batch.events, key))
            .returning()
        : [];
      requireCompleteUsageClaim(
        batch.events.length,
        events.length,
        args.social !== undefined,
      );
      work.pendingEvents = events.length;
      if (hasNoStandaloneUsage(events, args.social)) {
        return emptySettlementReceipt(work);
      }
      const currentPricing = await tx
        .select()
        .from(settlementPricingQuery(batch.pricingKeys));
      requireSettlementPricingSnapshot(batch.pricing, currentPricing);
      work.pricingRows = batch.prices.length;
      const priced = preparedSettlementPrices(args, batch, events);
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
      await tx.execute(settledEventsSql(charges, at));
      const prefix = requiredUsageGrantPrefix(batch.grants, charges.byUser);
      const grants = await tx
        .select()
        .from(preparedMemberGrantsQuery(orgId, prefix, at));
      const [unseenGrant] = await tx
        .select()
        .from(unseenGrantPrefixQuery(orgId, prefix, at));
      requireCurrentGrantPrefix(prefix, grants, unseenGrant);
      const deduction = planMemberGrantDeductions(charges.byUser, grants);
      await tx.execute(memberGrantDeductionsSql(deduction.updates));
      work.affectedUsers = charges.byUser.size;
      work.grantRows = grants.length;
      const amount = deduction.sharedCredits;
      const lotScope = usageExpiryScope(orgId, batch.lots, amount, at);
      const lots =
        amount > 0 ? await tx.select().from(expiryLotsQuery(lotScope)) : [];
      const [unseenLot] =
        amount > 0 ? await tx.select().from(unseenExpiryQuery(lotScope)) : [];
      const expiry = planCurrentExpiryDeduction(lotScope, lots, unseenLot);
      await tx.execute(expiryLotDeductionsSql(expiry.updates));
      work.expiredRows = expiry.expiredRows;
      work.expiryRows = expiry.expiryRows;
      const receiptState = { amount, wallet, expiry, work };
      let afterCredits = wallet?.credits ?? 0;
      if (amount > 0) {
        const debit = orgDebitPlan(orgId, amount, expiry.expired, at);
        const [debited] = await tx
          .insert(orgMetadataCanonicalWrites)
          .values(debit.values)
          .onConflictDoUpdate(debit.conflict)
          .returning();
        const metadata = requiredSettlementDebit(debited);
        const defaultPlan = settlementDefaultPlan(metadata);
        if (defaultPlan) {
          await tx
            .insert(orgPlanEntitlements)
            .values(defaultPlan)
            .onConflictDoNothing({ target: orgPlanEntitlements.orgId });
        }
        afterCredits = metadata.credits;
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
      return settlementReceipt(orgId, priced, {
        ...receiptState,
        afterCredits,
      });
    });
    signal.throwIfAborted();
    return { result, startedAt };
  },
);

export const settleOrgUsage$ = command(
  async ({ get, set }, args: UsageSettlementArgs, signal: AbortSignal) => {
    for (let attempt = 0; ; attempt++) {
      const batch = await set(prepareUsageSettlementBatch$, args, signal);
      const outcome = await settle(
        set(commitUsageBatch$, { ...args, batch }, signal),
      );
      signal.throwIfAborted();
      if (!outcome.ok) {
        if (
          outcome.error instanceof UsageSettlementSnapshotConflict &&
          attempt < 3
        ) {
          continue;
        }
        throw outcome.error;
      }
      const { result, startedAt } = outcome.value;
      if (result?.work.pendingEvents && !args.social) {
        reportCommittedSettlementPricing(
          args.orgId,
          batch,
          get(usagePricingResolution$),
        );
      }
      return result ? completeSettlementReceipt(result, startedAt) : null;
    }
  },
);
