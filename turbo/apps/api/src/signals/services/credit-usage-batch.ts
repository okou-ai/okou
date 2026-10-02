import type { PreparedUsageExpiryPrefix } from "./usage-expiry-prefix";
import type { PreparedUsageGrantPrefix } from "./usage-grant-prefix";
import type { PreparedSocialSettlement } from "./social-data-settlement-plan";
import {
  priceUsageEvents,
  type PricedUsageEvent,
  type UsageEventRecord,
} from "./credit-usage-pricing";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { usagePricing } from "@okouai/db/schema/usage-pricing";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  resolveUsagePricingProvider,
  type UsagePricingResolution,
} from "../context/usage-pricing-resolution";

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
export function settlementPricingKeys(
  rows: readonly PendingUsageSnapshot[],
  resolution: UsagePricingResolution,
) {
  return rows
    .filter(({ event }) => {
      return (
        event.pricingUnitPrice === null ||
        event.pricingUnitSize === null ||
        event.pricingCreditsLimit === null
      );
    })
    .map(({ event }) => {
      return {
        kind: event.kind,
        provider: resolveUsagePricingProvider(
          resolution,
          event.kind,
          event.provider,
        ),
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
export function requireCompleteUsageClaim(
  expected: number,
  actual: number,
  social: boolean,
) {
  if (!social && expected !== actual) {
    throw new UsageSettlementSnapshotConflict(
      "Usage batch changed during settlement preparation",
    );
  }
}

export function preparedSettlementPrices(
  args: { readonly orgId: string; readonly social?: unknown },
  batch: {
    readonly prices: readonly (typeof usagePricing.$inferSelect)[];
    readonly priced: PricedUsageEvent[];
    readonly social?: PreparedSocialSettlement;
  },
  events: readonly UsageEventRecord[],
) {
  if (!args.social) {
    return batch.priced;
  }
  const social = batch.social;
  if (!social) {
    // socialPlan already rejected a claimed job without a prepared snapshot.
    throw new Error("Social settlement has no prepared price");
  }
  return events.map((record) => {
    return { record, grossCredits: social.grossCredits, billingError: null };
  });
}
export function reportCommittedSettlementPricing(
  orgId: string,
  batch: {
    readonly records: UsageEventRecord[];
    readonly prices: (typeof usagePricing.$inferSelect)[];
  },
  resolution: UsagePricingResolution,
) {
  priceUsageEvents(batch.records, batch.prices, orgId, resolution);
}

export interface PreparedUsageBatch {
  readonly hasSocialReceipt: boolean;
  readonly grants: PreparedUsageGrantPrefix;
  readonly lots: PreparedUsageExpiryPrefix;
  readonly social?: PreparedSocialSettlement;
  readonly events: PendingUsageSnapshot[];
  readonly prices: (typeof usagePricing.$inferSelect)[];
  readonly records: (typeof usageEvent.$inferSelect)[];
  readonly priced: PricedUsageEvent[];
}
export function usageAllowanceRefreshArgs(
  args: { readonly orgId: string; readonly social?: unknown },
  batch: PreparedUsageBatch,
) {
  const { orgId } = args;
  if (args.social) {
    return batch.social &&
      batch.social.grossCredits > 0 &&
      !batch.hasSocialReceipt
      ? { orgId }
      : undefined;
  }
  const idempotencyKeys = batch.priced.flatMap((event) => {
    return event.grossCredits > 0 ? [event.record.idempotencyKey] : [];
  });
  return idempotencyKeys.length > 0
    ? { orgId, requirePendingUsage: true, idempotencyKeys }
    : undefined;
}

export function requiredSettlementDebit<T>(value: T | undefined): T {
  if (!value) {
    throw new Error("Organization debit returned no metadata row");
  }
  return value;
}
