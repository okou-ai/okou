import type { PreparedUsageBatch } from "./credit-usage-batch";
import type { PricedUsageEvent } from "./credit-usage-pricing";
import {
  planUsageCharges,
  planMemberGrantDeductions,
  planExpiryLotDeductions,
} from "./credit-usage-settlement-plan";

/** Freeze the credit split before committing. Concurrent overuse is accepted. */
export function usageFinancialPlan(
  batch: PreparedUsageBatch,
  priced: readonly PricedUsageEvent[],
  at: Date,
) {
  const charges = planUsageCharges(priced);
  const deduction = planMemberGrantDeductions(
    charges.byUser,
    batch.grants.grants.filter((grant) => {
      return grant.expiresAt > at;
    }),
  );
  const expiry = planExpiryLotDeductions(
    batch.lots.lots.filter((lot) => {
      return lot.expiresAt > at;
    }),
    deduction.sharedCredits,
    at,
  );
  return { at, priced, charges, deduction, expiry };
}

export type PreparedUsageFinancialPlan = ReturnType<typeof usageFinancialPlan>;
