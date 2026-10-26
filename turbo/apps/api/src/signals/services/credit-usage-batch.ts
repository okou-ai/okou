import {
  priceUsageEvents,
  type PricedUsageEvent,
  type UsageEventRecord,
} from "./credit-usage-pricing";
import { usageEvent } from "@okouai/db/runtime/usage-event";
import { usagePricing } from "@okouai/db/runtime/usage-pricing";
import { and, eq, inArray, or, sql } from "drizzle-orm";

export class UsageSettlementSnapshotConflict extends Error {}

export const USAGE_SETTLEMENT_BATCH_SIZE = 100;
export interface PendingUsageSnapshot {
  readonly event: typeof usageEvent.$inferSelect;
}
export function usageSnapshotCondition(rows: readonly PendingUsageSnapshot[]) {
  return (
    or(
      ...rows.map(({ event }) => {
        return eq(usageEvent.id, event.id);
      }),
    ) ?? sql`false`
  );
}
export function settlementPricingKeys(rows: readonly PendingUsageSnapshot[]) {
  return rows.map(({ event }) => {
    return {
      kind: event.kind,
      provider: event.provider,
      category: event.category,
    };
  });
}
export function settlementPricingCondition(
  keys: ReturnType<typeof settlementPricingKeys>,
) {
  return (
    or(
      ...keys.map((key) => {
        return and(
          eq(usagePricing.kind, key.kind),
          eq(usagePricing.provider, key.provider),
          inArray(usagePricing.category, [key.category, "__fallback__"]),
        );
      }),
    ) ?? sql`false`
  );
}
export function requireCompleteUsageClaim(expected: number, actual: number) {
  if (expected !== actual) {
    throw new UsageSettlementSnapshotConflict(
      "Usage batch changed during settlement preparation",
    );
  }
}

export function reportCommittedSettlementPricing(
  orgId: string,
  batch: {
    readonly records: UsageEventRecord[];
    readonly prices: (typeof usagePricing.$inferSelect)[];
  },
) {
  priceUsageEvents(batch.records, batch.prices, orgId);
}

export interface PreparedUsageBatch {
  readonly events: PendingUsageSnapshot[];
  readonly prices: (typeof usagePricing.$inferSelect)[];
  readonly records: (typeof usageEvent.$inferSelect)[];
  readonly priced: PricedUsageEvent[];
}
export function requiredSettlementDebit<T>(value: T | undefined): T {
  if (!value) {
    throw new Error("Organization debit returned no metadata row");
  }
  return value;
}
