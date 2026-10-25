import {
  OrgCreditExpirationConflict,
  orgCreditExpirationOutcome as expirationOutcome,
  orgCreditExpirationOutcomeRow as expRow,
  orgCreditExpirationSql as expSql,
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
  reportCommittedSettlementPricing,
} from "./credit-usage-batch";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { command } from "ccstate";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  claimUsageWhere as claimWhere,
  settlementObservation,
  emptySettlementReceipt,
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
 * settlement cycle (cron-process-usage-events or the next run completion)
 * prepares it again. It is never re-run in place.
 */
function deferredSettlementConflict(error: unknown) {
  return (
    error instanceof UsageSettlementSnapshotConflict ||
    error instanceof OrgCreditExpirationConflict
  );
}

interface UsageSettlementArgs {
  readonly orgId: string;
  readonly idempotencyKeys: readonly string[];
}

interface SettlementBatchArgs extends UsageSettlementArgs {
  readonly batch: PreparedUsageBatch;
  readonly financial: PreparedUsageFinancialPlan;
  readonly at: Date;
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
    requireCompleteUsageClaim(batch.events.length, rowCount ?? 0);
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
    const { orgId, batch, financial, at } = args;
    const { startedAt, work } = settlementObservation(batch.prices.length);
    // eslint-disable-next-line api/no-db-transaction -- Billing atomicity: usage claims, credit deductions and debt audit must commit together; single-statement alternative: the dependent validated cash plan and later fresh expiration snapshot require precommit whole-batch rollback.
    const result = await set(writeDb$).transaction(async (tx) => {
      const events = await tx
        .update(usageEvent)
        .set({ status: "processed", creditsCharged: 0, processedAt: at })
        .where(claimWhere(orgId, batch.events))
        .returning();
      requireCompleteUsageClaim(batch.events.length, events.length);
      Object.assign(work, { pendingEvents: events.length });
      if (events.length === 0) {
        return emptySettlementReceipt(work);
      }
      const { priced, charges } = financial;
      let afterCredits = 0;
      const cash = usageCashQueries(orgId, charges.byUser, at);
      const [wallet] = await tx.select().from(cash.wallet);
      requireUsageCashWallet(wallet);
      const grants = await tx.select().from(cash.grants);
      const deduction = planMemberGrantDeductions(charges.byUser, grants);
      if (deduction.sharedCredits > 0) {
        // Cash writers acquire the wallet before grant/expiry-lot locks.
        await tx.select().from(cash.wallet);
        const rows = parseRows(expRow, await tx.execute(expSql(orgId, at)));
        const outcome = expirationOutcome(rows);
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
      const amount = deduction.sharedCredits;
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
    const financial = usageFinancialPlan(batch.priced, nowDate());
    const outcome = await settle(
      financial.freeOnly
        ? set(
            commitFreeUsageBatch$,
            { orgId: args.orgId, batch, financial },
            signal,
          )
        : set(
            commitUsageBatch$,
            { ...args, batch, financial, at: financial.at },
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
    if (result.work.pendingEvents) {
      reportCommittedSettlementPricing(args.orgId, batch);
    }
    return completeSettlementReceipt(result, startedAt);
  },
);
