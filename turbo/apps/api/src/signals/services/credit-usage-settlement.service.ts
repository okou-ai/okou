import {
  commerceJobQuery,
  type CommerceSettlementJob,
  commerceClaimUnavailable,
  commercePlan,
  commerceReceiptPlan,
  requireCommerceSettlement,
} from "./commerce-job-settlement";
import { priceUsageEvents } from "./credit-usage-pricing";
import {
  OrgCreditExpirationConflict,
  orgCreditExpirationOutcome as expirationOutcome,
  orgCreditExpirationOutcomeRow as expirationRow,
  orgCreditExpirationSql as expirationSql,
  pendingOrgCreditExpirationQuery,
  requireCompleteOrgCreditExpiration,
} from "./org-credit-expiration";
import {
  usageCashQueries,
  usageCashExpiryLotsQuery,
  requireUsageCashWallet,
  usageCashWork,
} from "./usage-credit-deduction.service";
import { usagePackOverdraftTransferSql as packDebtSql } from "@okouai/db/operations/usage-pack-overdraft-transfer";
import {
  requireUsagePackOverdraftTransfer as requirePackDebt,
  usagePackOverdraftTransferOutcomeRow as debtRow,
} from "./usage-pack-overdraft-transfer.service";
import { parseRawRows as parseRows } from "../../lib/db-raw-rows";
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
  managedAttributionQuery as attributionQuery,
  managedAttributionWrite,
  managedBillingRunQuery as runQuery,
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
import {
  claimUsageWhere,
  settlementObservation,
  emptySettlementReceipt,
  hasNoStandaloneUsage,
  settledEventsSql,
  freeUsageSettlementSql,
  memberGrantDeductionsSql,
  planMemberGrantDeductions,
  planExpiryLotDeductions as planLots,
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
  readonly commerceJobId?: string;
}

interface SettlementBatchArgs extends UsageSettlementArgs {
  readonly batch: PreparedUsageBatch;
  readonly financial?: PreparedUsageFinancialPlan;
  readonly at: Date;
}

function settlementJobPlan(
  args: SettlementBatchArgs,
  socialJob:
    | (typeof socialDataJobs.$inferSelect & { readonly xmin: string })
    | undefined,
  commerceJob: CommerceSettlementJob | undefined,
) {
  if (
    socialClaimUnavailable(args.social, socialJob) ||
    commerceClaimUnavailable(args.commerceJobId, commerceJob)
  ) {
    return null;
  }
  const social = socialPlan(args.batch.social, socialJob);
  return {
    managed: commercePlan(args.batch.commerce, commerceJob) ?? social.usage,
    processPending: commerceJob !== undefined || social.processPending,
    jobScoped: socialJob !== undefined || commerceJob !== undefined,
  };
}

function noStandaloneEvents(
  events: readonly { readonly id: string }[],
  args: UsageSettlementArgs,
) {
  return hasNoStandaloneUsage(events, args.social) && !args.commerceJobId;
}

/** Social jobs create their event identity at commit; their prepared price
 * and captured policy are applied to the actual claimed event. */
function batchFinancialPlan(
  args: SettlementBatchArgs,
  events: (typeof usageEvent.$inferSelect)[],
) {
  return (
    args.financial ??
    usageFinancialPlan(
      args.commerceJobId
        ? priceUsageEvents(
            events.map((event) => {
              return {
                ...event,
                creditChargePolicy:
                  event.billingRunId &&
                  args.batch.freeOfficialRunOwners.get(event.billingRunId) ===
                    event.userId
                    ? ("official_workflow_free" as const)
                    : ("standard" as const),
              };
            }),
            args.batch.prices,
            args.orgId,
            false,
          )
        : preparedSettlementPrices(args, args.batch, events),
      args.at,
    )
  );
}

/**
 * Free Official usage has no financial row to commit with its claim, so it
 * settles in one statement without a transaction. An incomplete claim defers
 * the whole batch exactly like a rolled-back paid batch.
 */
const commitFreeUsageBatch$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly batch: PreparedUsageBatch;
      readonly financial: PreparedUsageFinancialPlan;
    },
    signal: AbortSignal,
  ) => {
    const { orgId, batch, financial } = args;
    const { startedAt, work } = settlementObservation(batch.prices.length);
    const { rowCount } = await set(writeDb$).execute(
      freeUsageSettlementSql(
        orgId,
        batch.events,
        financial.charges,
        financial.at,
      ),
    );
    signal.throwIfAborted();
    requireCompleteUsageClaim(batch.events.length, rowCount ?? 0, false);
    Object.assign(work, { pendingEvents: batch.events.length });
    const result = settlementReceipt(orgId, financial.priced, {
      amount: 0,
      work,
      afterCredits: 0,
    });
    return { result, startedAt };
  },
);

/**
 * All financial rows commit together; only plain values leave this command.
 * The pending claim prevents duplicate charging. Prices stay prepared,
 * but cash is re-read and locked before allocation.
 * Member grants cannot overdraw; all remaining charges debit the organization.
 * No external I/O runs inside this transaction.
 */
const commitUsageBatch$ = command(
  async ({ set }, args: SettlementBatchArgs, signal: AbortSignal) => {
    const { orgId, batch, at } = args;
    const { startedAt, work } = settlementObservation(batch.prices.length);
    // eslint-disable-next-line api/no-db-transaction -- Billing atomicity: usage publication/claims, credit deductions, debt audit and Social/Commerce receipts must commit together; single-statement alternative: the dependent validated cash plan, receipt CAS and later fresh expiration snapshot require precommit whole-batch rollback.
    const result = await set(writeDb$).transaction(async (tx) => {
      work.lockWaitMs = 0;
      const [job] = args.social
        ? await tx.select().from(socialJobQuery(orgId, args.social))
        : [];
      const [commerceJob] = args.commerceJobId
        ? await tx.select().from(commerceJobQuery(orgId, args.commerceJobId))
        : [];
      const plan = settlementJobPlan(args, job, commerceJob);
      if (!plan) {
        return null;
      }
      const { managed, processPending, jobScoped } = plan;
      if (managed) {
        const runId = managed.actor.runId;
        const [run] = await tx.select().from(runQuery(runId));
        let [attribution] = await tx.select().from(attributionQuery(runId));
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
      const events = processPending
        ? await tx
            .update(usageEvent)
            .set({ status: "processed", creditsCharged: 0, processedAt: at })
            .where(claimUsageWhere(orgId, batch.events, key))
            .returning()
        : [];
      requireCompleteUsageClaim(batch.events.length, events.length, jobScoped);
      Object.assign(work, { pendingEvents: events.length });
      if (noStandaloneEvents(events, args)) {
        return emptySettlementReceipt(work);
      }
      // Includes actual events claimed by the global processor, not just GET.
      const commerceReceipts = commerceReceiptPlan(batch.commerce, events, at);
      const { priced, charges, freeOnly } = batchFinancialPlan(args, events);
      let amount = 0;
      let afterCredits = 0;
      if (freeOnly) {
        // Free Social/Commerce usage also needs its durable job receipt in this
        // transaction. Standalone free usage can settle above in one statement.
        await tx.execute(settledEventsSql(charges, at));
      } else {
        const cash = usageCashQueries(orgId, charges.byUser, at);
        const [wallet] = await tx.select().from(cash.wallet);
        requireUsageCashWallet(wallet);
        const grants = await tx.select().from(cash.grants);
        const deduction = planMemberGrantDeductions(charges.byUser, grants);
        if (deduction.sharedCredits > 0) {
          // Cash writers acquire the wallet before grant/expiry-lot locks.
          await tx.select().from(cash.wallet);
          const outcome = expirationOutcome(
            parseRows(
              expirationRow,
              await tx.execute(expirationSql(orgId, at)),
            ),
          );
          // A later statement snapshot distinguishes remaining expired lots
          // from a concurrent clear or extension that completed expiration.
          const [remaining] =
            outcome.cleared === outcome.expected
              ? []
              : await tx
                  .select()
                  .from(pendingOrgCreditExpirationQuery(orgId, at));
          requireCompleteOrgCreditExpiration(orgId, outcome, remaining);
        }
        requirePackDebt(
          parseRows(debtRow, await tx.execute(packDebtSql({ orgId }, at))),
        );
        const lots =
          deduction.sharedCredits > 0
            ? await tx.select().from(usageCashExpiryLotsQuery(orgId, at))
            : [];
        const expiry = planLots(lots, deduction.sharedCredits, at);
        await tx.execute(settledEventsSql(charges, at));
        const grantSql = memberGrantDeductionsSql(deduction.updates);
        const granted = (await tx.execute(grantSql)).rowCount;
        requireConditionalDeductions("grant", deduction.updates, granted);
        amount = deduction.sharedCredits;
        const lotSql = expiryLotDeductionsSql(expiry.updates);
        const lotted = (await tx.execute(lotSql)).rowCount;
        requireConditionalDeductions("expiry lot", expiry.updates, lotted);
        Object.assign(work, usageCashWork(deduction, expiry));
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
      }
      if (commerceReceipts.expected > 0) {
        const { rowCount } = await tx.execute(commerceReceipts.sql);
        requireCommerceSettlement(commerceReceipts.expected, rowCount);
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
  async ({ set }, args: UsageSettlementArgs, signal: AbortSignal) => {
    const batch = await set(prepareUsageSettlementBatch$, args, signal);
    const financial =
      args.social || args.commerceJobId
        ? undefined
        : usageFinancialPlan(batch.priced, nowDate());
    const outcome = await settle(
      financial?.freeOnly && batch.commerce.length === 0
        ? set(
            commitFreeUsageBatch$,
            { orgId: args.orgId, batch, financial },
            signal,
          )
        : set(
            commitUsageBatch$,
            { ...args, batch, financial, at: financial?.at ?? nowDate() },
            signal,
          ),
    );
    signal.throwIfAborted();
    if (!outcome.ok) {
      if (deferredSettlementConflict(outcome.error)) {
        L.debug("Usage settlement snapshot deferred to the next cycle", {
          orgId: args.orgId,
          error: outcome.error,
        });
        return null;
      }
      throw outcome.error;
    }
    const { result, startedAt } = outcome.value;
    if (result?.work.pendingEvents && !args.social) {
      reportCommittedSettlementPricing(args.orgId, batch);
    }
    return result ? completeSettlementReceipt(result, startedAt) : null;
  },
);
