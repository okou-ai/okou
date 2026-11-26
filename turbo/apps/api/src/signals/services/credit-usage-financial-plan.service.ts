import {
  isPlatformPaidPolicy,
  type PricedUsageEvent,
} from "./credit-usage-pricing";
import { planUsageCharges } from "./credit-usage-settlement-plan";

/** Prepare prices; select current member and organization cash at commit. */
export function usageFinancialPlan(
  priced: readonly PricedUsageEvent[],
  at: Date,
) {
  const charges = planUsageCharges(priced);
  const freeOnly =
    priced.length > 0 &&
    priced.every((event) => {
      return isPlatformPaidPolicy(event.record.creditChargePolicy);
    });
  return { at, priced, charges, freeOnly };
}

export type PreparedUsageFinancialPlan = ReturnType<typeof usageFinancialPlan>;
