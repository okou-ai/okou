import { OrgCreditExpirationConflict } from "./org-credit-expiration";
import { expireOrgCreditsInTransaction } from "./org-credit-expiration.service";
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
  usageAllowanceRefreshArgs,
  UsageSettlementSnapshotConflict,
  requiredSettlementDebit,
  type PreparedUsageBatch,
  preparedSettlementPrices,
  reportCommittedSettlementPricing,
  requireSettlementPricingSnapshot,
  settlementPricingQuery,
} from "./credit-usage-batch";
import { socialDataJobs } from "@okouai/db/schema/social-data-job";
import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import { receiptQuery } from "./managed-usage-record";
import {
  managedAttributionQuery,
  managedAttributionWrite,
  managedBillingRunQuery,
} from "./managed-usage-attribution";
import {
  capturedManagedAttribution,
  managedUsagePublicationSql,
} from "./managed-usage-publication";
import {
  socialJobQuery,
  socialClaimUnavailable,
  socialPlan,
  socialValues,
  socialSettledWhere,
  requireSocialSettlement,
  type SocialSettlementClaim,
} from "./social-data-settlement-plan";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { command } from "ccstate";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { usagePricingResolution$ } from "../context/usage-pricing-resolution";
import {
  claimUsageWhere,
  settlementObservation,
  settlementOrgLockWaitMs,
  emptySettlementReceipt,
  hasNoStandaloneUsage,
  planUsageCharges,
  settledEventsSql,
  planMemberGrantDeductions,
  memberGrantDeductionsSql,
  expiryLotDeductionsSql,
  requireConditionalDeductions,
  orgDebitPlan,
  completeSettlementReceipt,
  settlementDefaultPlan,
  settlementReceipt,
} from "./credit-usage-settlement-plan";
import {
  entitlementQuery,
  allocationQuery,
  anchorQuery,
  planAllowanceCandidates,
  windowQuery,
  planAllowanceWrites,
  requireAllowanceWrite,
} from "./usage-allowance-settlement-plan";
import {
  prepareUsageAllowanceRefresh$,
  type PreparedUsageAllowanceRefresh,
} from "./usage-allowance.service";

const L = logger("CreditUsageSettlement");

/**
 * The whole settlement transaction rolled back because a conditional write
 * reported a stale snapshot. The batch stays pending; the existing next
 * settlement cycle (cron-process-usage-events, the next run completion or the
 * social job cycle) prepares it again. It is never re-run in place.
 */
function deferredSettlementConflict(error: unknown) {
  return (
    error instanceof UsageSettlementSnapshotConflict ||
    error instanceof OrgCreditExpirationConflict
  );
}

interface UsageSettlementArgs {
  readonly orgId: string;
  readonly idempotencyKeys?: readonly string[];
  readonly social?: SocialSettlementClaim;
}

interface SettlementBatchArgs extends UsageSettlementArgs {
  readonly refresh?: PreparedUsageAllowanceRefresh;
  readonly batch: PreparedUsageBatch;
}

/**
 * All financial rows commit together; only plain values leave this command.
 * No explicit row lock: the usage claim, allowance windows and consumption,
 * grant and lot deductions are conditional on the rows read, expiration and
 * the wallet debit are atomic arithmetic, and a short row count rejects the
 * batch with UsageSettlementSnapshotConflict (deferred, not retried).
 */
const commitUsageBatch$ = command(
  async ({ set }, args: SettlementBatchArgs, signal: AbortSignal) => {
    const { orgId, refresh, batch } = args;
    const { startedAt, work } = settlementObservation(batch.prices.length);
    const result = await set(writeDb$).transaction(async (tx) => {
      work.lockWaitMs = 0;
      const [job] = args.social
        ? await tx.select().from(socialJobQuery(orgId, args.social))
        : [];
      if (socialClaimUnavailable(args.social, job)) {
        return null;
      }
      const { usage: managed, processPending } = socialPlan(batch.social, job);
      if (managed) {
        const [run] = await tx
          .select()
          .from(managedBillingRunQuery(managed.actor.runId));
        let [attribution] = await tx
          .select()
          .from(managedAttributionQuery(managed.actor.runId));
        if (run && !attribution) {
          const capture = managedAttributionWrite(managed, run);
          const [captured] = await tx
            .insert(billingRunAttribution)
            .values(capture.values)
            .onConflictDoUpdate(capture.conflict)
            .returning({ runId: billingRunAttribution.runId });
          attribution = capturedManagedAttribution(run, captured);
        }
        await tx.execute(managedUsagePublicationSql(managed, run, attribution));
      }
      const key = managed?.idempotencyKey;
      const [entitlement] = await tx.select().from(entitlementQuery(orgId));
      const at = nowDate();
      work.orgLockWaitMs = settlementOrgLockWaitMs(startedAt, work.lockWaitMs);
      const events = processPending
        ? await tx
            .update(usageEvent)
            .set({ status: "processed", creditsCharged: 0, processedAt: at })
            .where(claimUsageWhere(orgId, batch.events, key))
            .returning()
        : [];
      requireCompleteUsageClaim(batch.events.length, events.length, !!job);
      Object.assign(work, { pendingEvents: events.length });
      if (hasNoStandaloneUsage(events, args.social)) {
        return emptySettlementReceipt(work);
      }
      const currentPricing = await tx
        .select()
        .from(settlementPricingQuery(batch.pricingKeys));
      requireSettlementPricingSnapshot(batch.pricing, currentPricing);
      const priced = preparedSettlementPrices(args, batch, events);
      const allocations = await tx.select().from(allocationQuery(priced));
      const anchors = await tx.select().from(anchorQuery(orgId, priced));
      const plan = planAllowanceCandidates(priced, allocations, anchors);
      const windows = await tx.select().from(windowQuery(orgId, plan));
      const scope = { orgId, refresh, at };
      const allowance = planAllowanceWrites(scope, plan, windows, entitlement);
      for (const write of allowance.writes) {
        const { rowCount } = await tx.execute(write.sql);
        requireAllowanceWrite(write.kind, write.planned, rowCount);
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
      const grantSql = memberGrantDeductionsSql(deduction.updates, at);
      const granted = (await tx.execute(grantSql)).rowCount;
      requireConditionalDeductions("grant", deduction.updates, granted);
      const amount = deduction.sharedCredits;
      if (amount > 0) {
        // Main's order: expire before the new deduction, in one statement.
        await expireOrgCreditsInTransaction(tx, orgId, at);
      }
      const lotScope = usageExpiryScope(orgId, batch.lots, amount, at);
      const lots =
        amount > 0 ? await tx.select().from(expiryLotsQuery(lotScope)) : [];
      const [unseenLot] =
        amount > 0 ? await tx.select().from(unseenExpiryQuery(lotScope)) : [];
      const expiry = planCurrentExpiryDeduction(lotScope, lots, unseenLot);
      const lotSql = expiryLotDeductionsSql(expiry.updates);
      const lotted = (await tx.execute(lotSql)).rowCount;
      requireConditionalDeductions("expiry lot", expiry.updates, lotted);
      Object.assign(work, deduction.work, expiry.work);
      let afterCredits = 0;
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
        const settled = await tx
          .update(socialDataJobs)
          .set(socialValues(managed, receipt, at))
          .where(socialSettledWhere(args.social, job))
          .returning({ id: socialDataJobs.id });
        requireSocialSettlement(settled.length);
      }
      signal.throwIfAborted();
      return settlementReceipt(orgId, priced, { amount, work, afterCredits });
    });
    signal.throwIfAborted();
    return { result, startedAt };
  },
);

/**
 * One prepare and one commit. A rejected snapshot returns null with the batch
 * still pending (a deterministic deferral to the next settlement cycle); any
 * other failure, including a deadlock victim's rollback, propagates.
 */
export const settleOrgUsage$ = command(
  async ({ get, set }, args: UsageSettlementArgs, signal: AbortSignal) => {
    const batch = await set(prepareUsageSettlementBatch$, args, signal);
    const refreshArgs = usageAllowanceRefreshArgs(args, batch);
    const refresh = refreshArgs
      ? await set(prepareUsageAllowanceRefresh$, refreshArgs, signal)
      : undefined;
    const outcome = await settle(
      set(commitUsageBatch$, { ...args, batch, refresh }, signal),
    );
    signal.throwIfAborted();
    if (!outcome.ok) {
      if (deferredSettlementConflict(outcome.error)) {
        L.warn("Usage settlement snapshot deferred to the next cycle", {
          orgId: args.orgId,
          error: outcome.error,
        });
        return null;
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
  },
);
