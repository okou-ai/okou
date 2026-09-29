import type { PreparedUsageGrantPrefix } from "./usage-grant-prefix";
import type { PreparedSocialSettlement } from "./social-data-settlement-plan";
import {
  priceUsageEvents,
  type PricedUsageEvent,
  type UsageEventRecord,
} from "./credit-usage-pricing";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { pgTextDecoder } from "../../lib/db-structured-result";
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
  readonly xmin: string;
}
export interface PricingSnapshot {
  readonly price: typeof usagePricing.$inferSelect;
  readonly xmin: string;
}
export function usageSnapshotCondition(rows: readonly PendingUsageSnapshot[]) {
  return (
    or(
      ...rows.map(({ event, xmin }) => {
        return and(
          eq(usageEvent.id, event.id),
          sql`${usageEvent}.xmin::text = ${xmin}`,
        );
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
export function requireSettlementPricingSnapshot(
  prepared: readonly PricingSnapshot[],
  current: readonly { id: string; xmin: string }[],
) {
  if (
    prepared.length !== current.length ||
    prepared.some(({ price, xmin }) => {
      return !current.some((row) => {
        return row.id === price.id && row.xmin === xmin;
      });
    })
  ) {
    throw new UsageSettlementSnapshotConflict(
      "Usage pricing changed during settlement preparation",
    );
  }
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

export function settlementPricingQuery(
  keys: ReturnType<typeof settlementPricingKeys>,
) {
  return new QueryBuilder()
    .select({
      id: usagePricing.id,
      xmin: sql`${usagePricing}.xmin::text`.mapWith(pgTextDecoder).as("xmin"),
    })
    .from(usagePricing)
    .where(settlementPricingCondition(keys))
    .for("share")
    .as("current_settlement_pricing");
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
  return args.social
    ? events.map((record) => {
        return {
          record,
          grossCredits: batch.social?.grossCredits ?? 0,
          billingError: null,
        };
      })
    : batch.priced;
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
  readonly grants: PreparedUsageGrantPrefix;
  readonly social?: PreparedSocialSettlement;
  readonly events: PendingUsageSnapshot[];
  readonly pricing: PricingSnapshot[];
  readonly pricingKeys: ReturnType<typeof settlementPricingKeys>;
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
