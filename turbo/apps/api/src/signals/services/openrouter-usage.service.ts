import { command } from "ccstate";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { usagePricing } from "@okouai/db/schema/usage-pricing";
import { and, eq, inArray } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";

import type { OpenRouterUsage } from "../external/openrouter";
import { writeDb$ } from "../external/db";
import {
  resolveUsagePricingProvider,
  usagePricingResolution$,
} from "../context/usage-pricing-resolution";
import { processOrgUsageEvents$ } from "./credit-usage.service";

const OPENROUTER_USAGE_IDEMPOTENCY_NAMESPACE =
  "3cf6f344-d67b-4d96-ae5d-fd6c0d134b70";

const INPUT_CATEGORY = "tokens.input";
const CACHE_READ_CATEGORY = "tokens.cache_read";
const OUTPUT_CATEGORY = "tokens.output";
const OPENROUTER_USAGE_CATEGORIES = [
  INPUT_CATEGORY,
  CACHE_READ_CATEGORY,
  OUTPUT_CATEGORY,
] as const;

interface OpenRouterUsageEntry {
  readonly category: (typeof OPENROUTER_USAGE_CATEGORIES)[number];
  readonly quantity: number;
}

interface RecordOpenRouterUsageArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string | undefined;
  readonly provider: string;
  // Recorded as the usage event `kind`, so pricing rows and usage displays
  // are scoped per task (like web-search vs people-search on one provider),
  // not per model.
  readonly operation: string;
  readonly operationId: string;
  readonly usage: OpenRouterUsage | undefined;
}

type OpenRouterUsageSettlement =
  | { readonly kind: "no-usage" }
  | { readonly kind: "settled"; readonly creditsCharged: number }
  | { readonly kind: "unsettled" };

function positiveInteger(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

function usageEntries(
  usage: OpenRouterUsage | undefined,
): OpenRouterUsageEntry[] {
  if (!usage) {
    return [];
  }

  const promptTokens = positiveInteger(usage.prompt_tokens);
  const cachedTokens = Math.min(
    promptTokens,
    positiveInteger(usage.prompt_tokens_details?.cached_tokens),
  );
  const inputTokens = promptTokens - cachedTokens;
  const outputTokens = positiveInteger(usage.completion_tokens);

  const entries: OpenRouterUsageEntry[] = [
    { category: INPUT_CATEGORY, quantity: inputTokens },
    { category: CACHE_READ_CATEGORY, quantity: cachedTokens },
    { category: OUTPUT_CATEGORY, quantity: outputTokens },
  ];
  return entries.filter((entry) => {
    return entry.quantity > 0;
  });
}

function usageIdempotencyKey(args: {
  readonly orgId: string;
  readonly operation: string;
  readonly operationId: string;
  readonly provider: string;
  readonly category: string;
}): string {
  return uuidv5(
    `${args.orgId}:${args.operation}:${args.operationId}:${args.provider}:${args.category}`,
    OPENROUTER_USAGE_IDEMPOTENCY_NAMESPACE,
  );
}

export const checkOpenRouterUsagePricing$ = command(
  async (
    { get, set },
    args: { readonly provider: string; readonly operation: string },
    signal: AbortSignal,
  ): Promise<readonly string[]> => {
    const writeDb = set(writeDb$);
    const provider = resolveUsagePricingProvider(
      get(usagePricingResolution$),
      args.operation,
      args.provider,
    );
    const rows = await writeDb
      .select({ category: usagePricing.category })
      .from(usagePricing)
      .where(
        and(
          eq(usagePricing.kind, args.operation),
          eq(usagePricing.provider, provider),
          inArray(usagePricing.category, [...OPENROUTER_USAGE_CATEGORIES]),
        ),
      );
    signal.throwIfAborted();

    const present = new Set(
      rows.map((row) => {
        return row.category;
      }),
    );
    return OPENROUTER_USAGE_CATEGORIES.filter((category) => {
      return !present.has(category);
    });
  },
);

export const recordOpenRouterUsage$ = command(
  async (
    { set },
    args: RecordOpenRouterUsageArgs,
    signal: AbortSignal,
  ): Promise<OpenRouterUsageSettlement> => {
    const entries = usageEntries(args.usage);
    if (entries.length === 0) {
      return { kind: "no-usage" };
    }

    const writeDb = set(writeDb$);
    const eventRows = entries.map((entry) => {
      return {
        runId: args.runId ?? null,
        billingContext: args.runId ? "run" : "runless",
        idempotencyKey: usageIdempotencyKey({
          orgId: args.orgId,
          operation: args.operation,
          operationId: args.operationId,
          provider: args.provider,
          category: entry.category,
        }),
        orgId: args.orgId,
        userId: args.userId,
        kind: args.operation,
        provider: args.provider,
        category: entry.category,
        quantity: entry.quantity,
      };
    });
    await writeDb
      .insert(usageEvent)
      .values(eventRows)
      .onConflictDoNothing({ target: [usageEvent.idempotencyKey] });
    signal.throwIfAborted();

    await set(processOrgUsageEvents$, args.orgId, signal);
    signal.throwIfAborted();

    const processed = await writeDb
      .select({
        billingError: usageEvent.billingError,
        creditsCharged: usageEvent.creditsCharged,
      })
      .from(usageEvent)
      .where(
        inArray(
          usageEvent.idempotencyKey,
          eventRows.map((event) => {
            return event.idempotencyKey;
          }),
        ),
      );
    signal.throwIfAborted();
    if (processed.length !== eventRows.length) {
      return { kind: "unsettled" };
    }

    let creditsCharged = 0;
    for (const event of processed) {
      if (event.billingError !== null || event.creditsCharged === null) {
        return { kind: "unsettled" };
      }
      creditsCharged += event.creditsCharged;
    }
    return { kind: "settled", creditsCharged };
  },
);
