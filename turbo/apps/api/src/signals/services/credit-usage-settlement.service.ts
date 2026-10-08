import { OrgCreditExpirationConflict } from "./org-credit-expiration";
import { prepareUsageCashInTransaction } from "./usage-credit-deduction.service";
import {
  prepareUsageFinancialPlan$,
  usageFinancialPlan,
  type PreparedUsageFinancialPlan,
} from "./credit-usage-financial-plan.service";
import {
  allowanceSettlementWrites,
  issuedAllowanceWindowsQuery,
} from "./usage-allowance-settlement-writes";
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
  emptySettlementReceipt,
  hasNoStandaloneUsage,
  settledEventsSql,
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
  insertWindowsSql,
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
  readonly financial?: PreparedUsageFinancialPlan;
  readonly at: Date;
}

/**
 * All financial rows commit together; only plain values leave this command.
 * The pending claim prevents duplicate charging. Prices and allowances stay
 * prepared, but cash is re-read and locked before allocation.
 * Member grants cannot overdraw; all remaining charges debit the organization.
 * No external I/O runs inside this transaction.
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
      const at = args.at;
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
      let financial = args.financial;
      if (!financial) {
        // Background Social jobs publish their usage in this transaction. Their
        // newly created event identity is required for allowance allocations.
        const priced = preparedSettlementPrices(args, batch, events);
        const [entitlement] = await tx.select().from(entitlementQuery(orgId));
        const allocations = await tx.select().from(allocationQuery(priced));
        const anchors = await tx.select().from(anchorQuery(orgId, priced));
        const plan = planAllowanceCandidates(priced, allocations, anchors);
        const windows = await tx.select().from(windowQuery(orgId, plan));
        const allowance = planAllowanceWrites(
          { orgId, refresh, at },
          plan,
          windows,
          entitlement,
        );
        financial = usageFinancialPlan(priced, allowance, at);
      }
      const { priced, allowance, charges } = financial;
      const { deduction, expiry } = await prepareUsageCashInTransaction(
        tx,
        orgId,
        charges.byUser,
        at,
      );
      if (allowance.refresh) {
        await tx.execute(allowance.refresh);
      }
      await tx.execute(insertWindowsSql(allowance.inserted));
      const canonicalWindows = allowance.inserted.length
        ? await tx.select().from(issuedAllowanceWindowsQuery(allowance))
        : [];
      for (const write of allowanceSettlementWrites(
        allowance,
        canonicalWindows,
      )) {
        const { rowCount } = await tx.execute(write.sql);
        requireAllowanceWrite(write.kind, write.planned, rowCount);
      }
      await tx.execute(settledEventsSql(charges, at));
      const grantSql = memberGrantDeductionsSql(deduction.updates);
      const granted = (await tx.execute(grantSql)).rowCount;
      requireConditionalDeductions("grant", deduction.updates, granted);
      const amount = deduction.sharedCredits;
      const lotSql = expiryLotDeductionsSql(expiry.updates);
      const lotted = (await tx.execute(lotSql)).rowCount;
      requireConditionalDeductions("expiry lot", expiry.updates, lotted);
      Object.assign(work, deduction.work, {
        expiredRows: expiry.expiredRows,
        expiryRows: expiry.expiryRows,
      });
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
    const financial = args.social
      ? undefined
      : await set(
          prepareUsageFinancialPlan$,
          { orgId: args.orgId, batch, refresh },
          signal,
        );
    const outcome = await settle(
      set(
        commitUsageBatch$,
        { ...args, batch, refresh, financial, at: financial?.at ?? nowDate() },
        signal,
      ),
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
