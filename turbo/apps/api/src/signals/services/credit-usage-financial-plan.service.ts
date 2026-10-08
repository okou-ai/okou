import type { PricedUsageEvent } from "./credit-usage-pricing";
import { planUsageCharges } from "./credit-usage-settlement-plan";

/** Prepare prices; select current member and organization cash at commit. */
export function usageFinancialPlan(
  priced: readonly PricedUsageEvent[],
  at: Date,
) {
  const charges = planUsageCharges(priced);
  return { at, priced, charges };
}

export type PreparedUsageFinancialPlan = ReturnType<typeof usageFinancialPlan>;
