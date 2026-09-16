import { valueModelUsage } from "@okouai/core/model-usage-cost";
import { usagePricing } from "@okouai/db/schema/usage-pricing";
import { PI_MEMORY_STAGE1_MODEL } from "@okouai/pi-agent-runtime/api";
import { and, eq, sql } from "drizzle-orm";

import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import {
  resolveUsagePricingProvider,
  type UsagePricingResolution,
} from "../context/usage-pricing-resolution";
import type { Db } from "../external/db";
import { safeSync, settleIncludingAbort } from "../utils";
import {
  piMemoryStage1AccountingId,
  piMemoryStage1UsageEntries,
  type PiMemoryStage1UsageReceipt,
  type RecordPiMemoryStage1UsageArgs,
} from "./pi-memory-stage1-usage.service";

const log = logger("PiMemoryStage1Cost");

/** Best-effort observation only: callers must record canonical usage first. */
export async function observePiMemoryStage1Cost(
  db: Db,
  args: RecordPiMemoryStage1UsageArgs,
  receipt: PiMemoryStage1UsageReceipt | null,
  pricingResolution: UsagePricingResolution,
): Promise<void> {
  // Own both pricing and synchronous logging failures, including abort errors.
  // Neither may turn already consumed provider work into a paid retry.
  await settleIncludingAbort(
    (async () => {
      const observedAt = nowDate().toISOString();
      const entries = safeSync(() => {
        return piMemoryStage1UsageEntries(args.usage);
      });
      const base = {
        operation: "pi_memory_stage1",
        costVersion: 1,
        accountingId: piMemoryStage1AccountingId(args),
        accountingAt: receipt?.accountingAt ?? null,
        observedAt,
        billingMode: args.billing.mode,
        model: PI_MEMORY_STAGE1_MODEL,
        usageStatus: "ok" in entries ? "valid" : "invalid",
        ledgerStatus: receipt?.disposition ?? "persistence_error",
        inputTokens: "ok" in entries ? args.usage.input : null,
        outputTokens: "ok" in entries ? args.usage.output : null,
        cacheReadTokens: "ok" in entries ? args.usage.cacheRead : null,
        cacheCreationTokens: "ok" in entries ? args.usage.cacheWrite : null,
        currency: "USD",
        unit: "gross_credit_value",
        creditsPerUsd: 1000,
      };
      if (!("ok" in entries) || receipt?.disposition !== "new") {
        log.info("Pi memory Stage 1 cost observed", {
          ...base,
          pricingStatus: !("ok" in entries)
            ? "invalid_usage"
            : (receipt?.disposition ?? "persistence_error"),
          grossCreditValueUsd: null,
          grossCreditValueNanoUsd: null,
          priceBasis: null,
        });
        return;
      }
      const pricingProvider = resolveUsagePricingProvider(
        pricingResolution,
        "model",
        PI_MEMORY_STAGE1_MODEL,
      );
      const prices = await settleIncludingAbort(
        db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL statement_timeout = '1s'`);
          return await tx
            .select({
              category: usagePricing.category,
              unitPrice: usagePricing.unitPrice,
              unitSize: usagePricing.unitSize,
              updatedAt: usagePricing.updatedAt,
            })
            .from(usagePricing)
            .where(
              and(
                eq(usagePricing.kind, "model"),
                eq(usagePricing.provider, pricingProvider),
              ),
            );
        }),
      );
      const valuation = prices.ok
        ? valueModelUsage(entries.ok, prices.value)
        : {
            pricingStatus: "pricing_error",
            grossCreditValueUsd: null,
            grossCreditValueNanoUsd: null,
          };
      log.info("Pi memory Stage 1 cost observed", {
        ...base,
        ...valuation,
        pricingProvider,
        // A string is deliberate: APL compares a complete observation price basis.
        priceBasis: prices.ok
          ? JSON.stringify(
              entries.ok.map((entry) => {
                const price = prices.value.find((row) => {
                  return row.category === entry.category;
                });
                return {
                  ...entry,
                  unitPrice: price?.unitPrice ?? null,
                  unitSize: price?.unitSize ?? null,
                  priceUpdatedAt: price?.updatedAt.toISOString() ?? null,
                };
              }),
            )
          : null,
      });
    })(),
  );
}

/** No usable response usage: unknown vendor cost, never a zero-valued response. */
export async function observePiMemoryStage1MissingUsage(
  billingMode: "builtin" | "byok",
): Promise<void> {
  await settleIncludingAbort(() => {
    log.info("Pi memory Stage 1 cost observed", {
      operation: "pi_memory_stage1",
      costVersion: 1,
      billingMode,
      model: PI_MEMORY_STAGE1_MODEL,
      usageStatus: "missing",
      ledgerStatus: "not_recorded",
      pricingStatus: "missing_usage",
      observedAt: nowDate().toISOString(),
      accountingId: null,
      accountingAt: null,
      currency: "USD",
      unit: "gross_credit_value",
      creditsPerUsd: 1000,
      grossCreditValueUsd: null,
      grossCreditValueNanoUsd: null,
      priceBasis: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    });
  });
}
