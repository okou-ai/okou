import { piNativeCatalogModelSchema } from "@okouai/api-contracts/contracts/pi-native-models";
import { createHash } from "node:crypto";

import type { PiModelConfigV4 } from "@okouai/api-contracts/contracts/pi-native";
import type { z } from "zod";
import { MODEL_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS } from "@okouai/api-contracts/contracts/model-price-tiers";
import type { PiModelConfig } from "@okouai/api-contracts/contracts/runners";
import { usageEvent } from "@okouai/db/schema/usage-event";
import type { PiApiFirstTurnResult } from "@okouai/pi-agent-runtime/api";
import { inArray } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";

import type { Db } from "../external/db";
import { isPiGptModel, type PiGptModel } from "@okouai/core/pi-execution";

const PI_API_FIRST_TURN_USAGE_NAMESPACE =
  "26e1c547-485d-4438-bf6d-4b77959da0cb";
const DEEPSEEK_FLASH_MODEL = "deepseek-v4-flash";
const DEEPSEEK_PRO_MODEL = "deepseek-v4-pro";

type PiApiFirstTurnUsageProvider =
  | PiGptModel
  | typeof DEEPSEEK_FLASH_MODEL
  | typeof DEEPSEEK_PRO_MODEL
  | z.infer<typeof piNativeCatalogModelSchema>;

function gptLongContextMinimumInputTokens(model: PiGptModel): number {
  const minimum = MODEL_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS[model];
  if (minimum === undefined) {
    throw new Error(`${model} long-context pricing threshold is missing`);
  }
  return minimum;
}

type PiUsageCategoryBase =
  | "tokens.input"
  | "tokens.output"
  | "tokens.cache_read"
  | "tokens.cache_creation";
type PiUsageCategory =
  | PiUsageCategoryBase
  | `${PiUsageCategoryBase}.long_context`
  | `${PiUsageCategoryBase}.fast`
  | `${PiUsageCategoryBase}.long_context.fast`;

interface PiApiFirstTurnUsageEntry {
  readonly category: PiUsageCategory;
  readonly quantity: number;
}

interface RecordPiApiFirstTurnUsageArgs {
  readonly runId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly billableFirewalls: readonly string[];
  readonly modelUsageProvider: string | undefined;
  readonly piProvider: PiModelConfig["provider"];
  readonly nativeModelConfig?: PiModelConfigV4;
  readonly requestedServiceTier: "priority" | "fast" | undefined;
  readonly turn: PiApiFirstTurnResult;
}

function usageQuantity(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Pi API first-turn ${field} usage is invalid`);
  }
  return value;
}

function sourceId(turn: PiApiFirstTurnResult): string {
  return (
    turn.assistantMessage.responseId ??
    createHash("sha256").update(turn.sessionJsonl).digest("hex")
  );
}

function idempotencyKey(namespace: string, parts: readonly string[]): string {
  return uuidv5(JSON.stringify(parts), namespace);
}

function gptApiFirstTurnUsageEntries(
  model: PiGptModel,
  turn: PiApiFirstTurnResult,
  fast: boolean,
): readonly PiApiFirstTurnUsageEntry[] {
  const usage = turn.assistantMessage.usage;
  const input = usageQuantity(usage.input, "input");
  const output = usageQuantity(usage.output, "output");
  const cacheRead = usageQuantity(usage.cacheRead, "cache-read");
  const cacheCreation = usageQuantity(usage.cacheWrite, "cache-creation");
  const longContext =
    input + cacheRead + cacheCreation >=
    gptLongContextMinimumInputTokens(model);
  const category = (base: PiUsageCategoryBase): PiUsageCategory => {
    if (longContext) {
      return fast ? `${base}.long_context.fast` : `${base}.long_context`;
    }
    return fast ? `${base}.fast` : base;
  };
  return (
    [
      { category: category("tokens.input"), quantity: input },
      { category: category("tokens.output"), quantity: output },
      { category: category("tokens.cache_read"), quantity: cacheRead },
      {
        category: category("tokens.cache_creation"),
        quantity: cacheCreation,
      },
    ] satisfies readonly {
      readonly category: PiUsageCategory;
      readonly quantity: number;
    }[]
  ).filter((entry) => {
    return entry.quantity > 0;
  });
}

/** Native Claude and DeepSeek retain the canonical base token categories. */
function baseApiFirstTurnUsageEntries(
  turn: PiApiFirstTurnResult,
): readonly PiApiFirstTurnUsageEntry[] {
  const usage = turn.assistantMessage.usage;
  return (
    [
      {
        category: "tokens.input",
        quantity: usageQuantity(usage.input, "input"),
      },
      {
        category: "tokens.output",
        quantity: usageQuantity(usage.output, "output"),
      },
      {
        category: "tokens.cache_read",
        quantity: usageQuantity(usage.cacheRead, "cache-read"),
      },
      {
        category: "tokens.cache_creation",
        quantity: usageQuantity(usage.cacheWrite, "cache-creation"),
      },
    ] satisfies readonly {
      readonly category: PiUsageCategoryBase;
      readonly quantity: number;
    }[]
  ).filter((entry) => {
    return entry.quantity > 0;
  });
}

function piApiFirstTurnUsageProvider(
  provider: string | undefined,
): PiApiFirstTurnUsageProvider | null {
  if (
    isPiGptModel(provider) ||
    provider === DEEPSEEK_FLASH_MODEL ||
    provider === DEEPSEEK_PRO_MODEL
  ) {
    return provider;
  }
  const native = piNativeCatalogModelSchema.safeParse(provider);
  return native.success ? native.data : null;
}

function isFastPiApiFirstTurn(args: RecordPiApiFirstTurnUsageArgs): boolean {
  if (args.piProvider === "openrouter") {
    return (
      args.turn.observedServiceTier === "priority" ||
      args.turn.observedServiceTier === "fast"
    );
  }
  // Preserve direct OpenAI's accepted requested-tier billing contract.
  return args.requestedServiceTier === "priority";
}

/**
 * Persist API-owned billing usage before any lifecycle commit. The response
 * identity keeps retries and late cancellation observers converged on the same
 * immutable ledger rows. Sandbox provider calls keep their independent
 * MITM-owned delivery identities.
 */
export async function recordPiApiFirstTurnUsage(
  db: Db,
  args: RecordPiApiFirstTurnUsageArgs,
): Promise<void> {
  if (args.nativeModelConfig?.billingOwner === "user") {
    return;
  }
  if (
    args.nativeModelConfig &&
    args.modelUsageProvider !== args.nativeModelConfig.catalogModel
  ) {
    throw new Error(
      "Pi native model billing identity does not match its catalog",
    );
  }
  const hasBillableModelProvider = args.billableFirewalls.some((firewall) => {
    return firewall.startsWith("model-provider:");
  });
  const provider = piApiFirstTurnUsageProvider(args.modelUsageProvider);
  if (!hasBillableModelProvider || provider === null) {
    return;
  }
  if (
    args.nativeModelConfig &&
    args.turn.assistantMessage.usage.cacheWrite1h !== undefined
  ) {
    const longCache = usageQuantity(
      args.turn.assistantMessage.usage.cacheWrite1h,
      "one-hour-cache-creation",
    );
    if (longCache > args.turn.assistantMessage.usage.cacheWrite) {
      throw new Error("Pi native cache TTL partition is invalid");
    }
  }
  const responseSourceId = sourceId(args.turn);
  const entries = isPiGptModel(provider)
    ? gptApiFirstTurnUsageEntries(
        provider,
        args.turn,
        isFastPiApiFirstTurn(args),
      )
    : baseApiFirstTurnUsageEntries(args.turn);
  const usageRows = entries.map((entry) => {
    return {
      runId: args.runId,
      idempotencyKey: idempotencyKey(PI_API_FIRST_TURN_USAGE_NAMESPACE, [
        args.runId,
        responseSourceId,
        entry.category,
      ]),
      orgId: args.orgId,
      userId: args.userId,
      kind: "model",
      provider,
      category: entry.category,
      quantity: entry.quantity,
    } as const;
  });
  if (usageRows.length === 0) {
    return;
  }
  await db.transaction(async (tx) => {
    await tx
      .insert(usageEvent)
      .values(usageRows)
      .onConflictDoNothing({ target: [usageEvent.idempotencyKey] });
    const storedUsageRows = await tx
      .select({
        idempotencyKey: usageEvent.idempotencyKey,
        runId: usageEvent.runId,
        orgId: usageEvent.orgId,
        userId: usageEvent.userId,
        kind: usageEvent.kind,
        provider: usageEvent.provider,
        category: usageEvent.category,
        quantity: usageEvent.quantity,
      })
      .from(usageEvent)
      .where(
        inArray(
          usageEvent.idempotencyKey,
          usageRows.map((row) => {
            return row.idempotencyKey;
          }),
        ),
      );
    const expectedByKey = new Map(
      usageRows.map((row) => {
        return [row.idempotencyKey, row] as const;
      }),
    );
    for (const row of storedUsageRows) {
      const expected = expectedByKey.get(row.idempotencyKey);
      if (
        !expected ||
        row.runId !== expected.runId ||
        row.orgId !== expected.orgId ||
        row.userId !== expected.userId ||
        row.kind !== expected.kind ||
        row.provider !== expected.provider ||
        row.category !== expected.category ||
        row.quantity !== expected.quantity
      ) {
        throw new Error("Pi API first-turn usage identity collision");
      }
      expectedByKey.delete(row.idempotencyKey);
    }
    if (expectedByKey.size > 0) {
      throw new Error("Pi API first-turn usage persistence is incomplete");
    }
  });
}
