import { OrgCreditExpirationConflict } from "./org-credit-expiration";
import { expireOrgCreditsInTransaction } from "./org-credit-expiration.service";
import {
  usageFinancialPlan,
  type PreparedUsageFinancialPlan,
} from "./credit-usage-financial-plan.service";
import { settle } from "../utils";
import { prepareUsageSettlementBatch$ } from "./credit-usage-batch-prepare.service";
import {
  requireCompleteUsageClaim,
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
  readonly batch: PreparedUsageBatch;
  readonly financial?: PreparedUsageFinancialPlan;
  readonly at: Date;
}

/**
 * All financial rows commit together; only plain values leave this command.
 * The pending claim prevents duplicate charging. Prepared credit splits
 * use atomic arithmetic without old-version or balance checks; concurrent
 * overuse is accepted. No external I/O runs inside this transaction.
 */
const commitUsageBatch$ = command(
  async ({ set }, args: SettlementBatchArgs, signal: AbortSignal) => {
    const { orgId, batch } = args;
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
        // Background Social jobs publish and claim their usage atomically.
        // Their newly created event identity receives the prepared price.
        const priced = preparedSettlementPrices(args, batch, events);
        financial = usageFinancialPlan(batch, priced, at);
      }
      const { priced, charges, deduction, expiry } = financial;
      await tx.execute(settledEventsSql(charges, at));
      const grantSql = memberGrantDeductionsSql(deduction.updates);
      const granted = (await tx.execute(grantSql)).rowCount;
      requireConditionalDeductions("grant", deduction.updates, granted);
      const amount = deduction.sharedCredits;
      if (amount > 0) {
        // Main's order: expire before the new deduction, in one statement.
        await expireOrgCreditsInTransaction(tx, orgId, at);
      }
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
    const financial = args.social
      ? undefined
      : usageFinancialPlan(batch, batch.priced, nowDate());
    const outcome = await settle(
      set(
        commitUsageBatch$,
        { ...args, batch, financial, at: financial?.at ?? nowDate() },
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
