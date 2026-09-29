import { usagePricing } from "@okouai/db/schema/usage-pricing";
import { logger } from "../../lib/log";
import { usageUnderbillingFields } from "../usage-underbilling";
import {
  resolveUsagePricingProvider,
  type UsagePricingResolution,
} from "../context/usage-pricing-resolution";
import type { CreditLowBalanceAlertArgs } from "./credit-low-balance-alert.service";

const L = logger("CreditUsage");

export interface SettlementWorkObservation {
  readonly lockWaitMs: number;
  readonly orgLockWaitMs: number;
  readonly settlementWorkMs: number;
  readonly transactionDurationMs?: number;
  readonly pendingEvents: number;
  readonly pricingRows: number;
  readonly affectedUsers: number;
  readonly grantRows: number;
  readonly expiredRows: number;
  readonly expiryRows: number;
}

export interface ProcessOrgUsageEventsResult {
  readonly sharedCreditsCharged: number;
  readonly runIds: readonly string[];
  readonly lowBalanceAlert: CreditLowBalanceAlertArgs | null;
  readonly work: SettlementWorkObservation;
}

export interface UsageEventRecord {
  readonly id: string;
  readonly runId: string | null;
  readonly billingAnchorAt: Date | null;
  readonly idempotencyKey: string;
  readonly userId: string;
  readonly kind: string;
  readonly provider: string;
  readonly category: string;
  readonly quantity: number;
  readonly pricingUnitPrice: number | null;
  readonly pricingUnitSize: number | null;
  readonly pricingCreditsLimit: number | null;
  readonly createdAt: Date;
}
type UsagePricingRecord = typeof usagePricing.$inferSelect;
type UsageEventBillingError = "missing_pricing" | "fallback_pricing" | null;

export interface PricedUsageEvent {
  readonly record: UsageEventRecord;
  readonly grossCredits: number;
  readonly billingError: UsageEventBillingError;
}

export function priceUsageEvents(
  records: readonly UsageEventRecord[],
  pricingRecords: readonly UsagePricingRecord[],
  orgId: string,
  pricingResolution: UsagePricingResolution,
): PricedUsageEvent[] {
  const pricingByKey = new Map(
    pricingRecords.map((pricing) => {
      return [
        `${pricing.kind}|${pricing.provider}|${pricing.category}`,
        pricing,
      ];
    }),
  );
  const pricedEvents: PricedUsageEvent[] = [];
  for (const record of records) {
    if (
      record.pricingUnitPrice !== null &&
      record.pricingUnitSize !== null &&
      record.pricingCreditsLimit !== null
    ) {
      const numerator =
        BigInt(record.quantity) * BigInt(record.pricingUnitPrice);
      const denominator = BigInt(record.pricingUnitSize);
      const credits = (numerator + denominator - 1n) / denominator;
      const limit = BigInt(record.pricingCreditsLimit);
      pricedEvents.push({
        record,
        grossCredits: Number(credits < limit ? credits : limit),
        billingError: null,
      });
      continue;
    }
    const lookupProvider = resolveUsagePricingProvider(
      pricingResolution,
      record.kind,
      record.provider,
    );
    const exactPricing = pricingByKey.get(
      `${record.kind}|${lookupProvider}|${record.category}`,
    );
    const pricing =
      exactPricing ??
      pricingByKey.get(`${record.kind}|${lookupProvider}|__fallback__`);

    if (!pricing) {
      L.error("Missing usage_pricing — charged zero", {
        ...usageUnderbillingFields("missing_pricing", "confirmed"),
        orgId,
        runId: record.runId,
        idempotencyKey: record.idempotencyKey,
        userId: record.userId,
        kind: record.kind,
        provider: record.provider,
        category: record.category,
        quantity: record.quantity,
      });
      pricedEvents.push({
        record,
        grossCredits: 0,
        billingError: "missing_pricing",
      });
      continue;
    }

    if (!exactPricing) {
      L.error("Missing usage_pricing — billed at fallback rate", {
        ...usageUnderbillingFields("fallback_pricing", "confirmed"),
        orgId,
        runId: record.runId,
        idempotencyKey: record.idempotencyKey,
        userId: record.userId,
        kind: record.kind,
        provider: record.provider,
        category: record.category,
        quantity: record.quantity,
        fallbackUnitPrice: pricing.unitPrice,
      });
    }

    pricedEvents.push({
      record,
      grossCredits: Math.ceil(
        (record.quantity * pricing.unitPrice) / pricing.unitSize,
      ),
      billingError: exactPricing ? null : "fallback_pricing",
    });
  }
  return pricedEvents;
}
