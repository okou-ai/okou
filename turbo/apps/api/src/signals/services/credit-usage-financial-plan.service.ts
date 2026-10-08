import { command } from "ccstate";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import type { PreparedUsageBatch } from "./credit-usage-batch";
import type { PricedUsageEvent } from "./credit-usage-pricing";
import { planUsageCharges } from "./credit-usage-settlement-plan";
import {
  entitlementQuery,
  allocationQuery,
  anchorQuery,
  planAllowanceCandidates,
  windowQuery,
  planAllowanceWrites,
} from "./usage-allowance-settlement-plan";
import type { PreparedUsageAllowanceRefresh } from "./usage-allowance.service";

/** Prices and allowance allocations are prepared; cash is selected under locks at commit. */
export function usageFinancialPlan(
  priced: readonly PricedUsageEvent[],
  allowance: ReturnType<typeof planAllowanceWrites>,
  at: Date,
) {
  const charges = planUsageCharges(priced, allowance.applied);
  return { at, priced, allowance, charges };
}

export type PreparedUsageFinancialPlan = ReturnType<typeof usageFinancialPlan>;

export const prepareUsageFinancialPlan$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly batch: PreparedUsageBatch;
      readonly refresh: PreparedUsageAllowanceRefresh | undefined;
    },
    signal: AbortSignal,
  ): Promise<PreparedUsageFinancialPlan> => {
    const db = set(writeDb$);
    const at = nowDate();
    const priced = args.batch.priced;
    const [entitlement] = await db.select().from(entitlementQuery(args.orgId));
    signal.throwIfAborted();
    const allocations = await db.select().from(allocationQuery(priced));
    signal.throwIfAborted();
    const anchors = await db.select().from(anchorQuery(args.orgId, priced));
    signal.throwIfAborted();
    const plan = planAllowanceCandidates(priced, allocations, anchors);
    const windows = await db.select().from(windowQuery(args.orgId, plan));
    signal.throwIfAborted();
    const allowance = planAllowanceWrites(
      { orgId: args.orgId, refresh: args.refresh, at },
      plan,
      windows,
      entitlement,
    );
    return usageFinancialPlan(priced, allowance, at);
  },
);
