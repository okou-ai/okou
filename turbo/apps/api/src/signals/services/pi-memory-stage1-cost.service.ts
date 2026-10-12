import type { PiMemoryStage1Model } from "@okouai/pi-agent-runtime/api";
import { command } from "ccstate";

import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { safeSync, settleIncludingAbort } from "../utils";
import {
  piMemoryStage1AccountingId,
  piMemoryStage1UsageEntries,
  type PiMemoryStage1UsageReceipt,
  type RecordPiMemoryStage1UsageArgs,
} from "./pi-memory-stage1-usage.service";

const log = logger("PiMemoryStage1Cost");

function unpricedCreditValue(receipt: PiMemoryStage1UsageReceipt | null) {
  return receipt?.disposition === "free"
    ? { grossCreditValueUsd: 0, grossCreditValueNanoUsd: "0" }
    : { grossCreditValueUsd: null, grossCreditValueNanoUsd: null };
}

/** Best-effort observation only: callers must record canonical usage first. */
export const observePiMemoryStage1Cost$ = command(
  async (
    _,
    args: RecordPiMemoryStage1UsageArgs,
    receipt: PiMemoryStage1UsageReceipt | null,
  ): Promise<void> => {
    // Own synchronous observation/logging failures, including abort errors.
    // Neither may turn already consumed provider work into another attempt.
    await settleIncludingAbort(() => {
      const observedAt = nowDate().toISOString();
      const entries = safeSync(() => {
        return piMemoryStage1UsageEntries(
          args.usage,
          args.longContextMinTotalInputTokens,
        );
      });
      const base = {
        operation: "pi_memory_stage1",
        costVersion: 1,
        accountingId: piMemoryStage1AccountingId(args),
        accountingAt: receipt?.accountingAt ?? null,
        observedAt,
        billingMode: args.billing.mode,
        model: args.model,
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
      log.info("Pi memory Stage 1 cost observed", {
        ...base,
        pricingStatus: !("ok" in entries)
          ? "invalid_usage"
          : (receipt?.disposition ?? "persistence_error"),
        ...unpricedCreditValue(receipt),
        priceBasis: null,
      });
    });
  },
);

/** No usable response usage: unknown vendor cost, never a zero-valued response. */
export async function observePiMemoryStage1MissingUsage(
  billingMode: "builtin" | "subscription" | "free",
  model: PiMemoryStage1Model,
): Promise<void> {
  await settleIncludingAbort(() => {
    log.info("Pi memory Stage 1 cost observed", {
      operation: "pi_memory_stage1",
      costVersion: 1,
      billingMode,
      model,
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
