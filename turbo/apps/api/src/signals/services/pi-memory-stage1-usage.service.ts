import { MODEL_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS } from "@okouai/api-contracts/contracts/model-price-tiers";
import { usageEvent } from "@okouai/db/schema/usage-event";
import {
  PI_MEMORY_STAGE1_MODEL,
  type PiMemoryStage1ProviderUsage,
} from "@okouai/pi-agent-runtime/api";
import { inArray } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";

import type { Db } from "../external/db";

const PI_MEMORY_STAGE1_USAGE_NAMESPACE = "4a535d58-0d9a-44d4-aee8-8d3fa2901314";

type UsageCategoryBase =
  | "tokens.input"
  | "tokens.output"
  | "tokens.cache_read"
  | "tokens.cache_creation";
type UsageCategory = UsageCategoryBase | `${UsageCategoryBase}.long_context`;

interface UsageEntry {
  readonly category: UsageCategory;
  readonly quantity: number;
}

interface RecordPiMemoryStage1UsageArgs {
  readonly memoryStorageId: string;
  readonly piSessionId: string;
  readonly sourceHistoryHash: string;
  readonly orgId: string;
  readonly userId: string;
  readonly responseSourceId: string;
  readonly usage: PiMemoryStage1ProviderUsage;
}

function quantity(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Pi memory Stage 1 ${field} usage is invalid`);
  }
  return value;
}

function usageEntries(usage: PiMemoryStage1ProviderUsage): UsageEntry[] {
  const input = quantity(usage.input, "input");
  const output = quantity(usage.output, "output");
  const cacheRead = quantity(usage.cacheRead, "cache-read");
  const cacheCreation = quantity(usage.cacheWrite, "cache-creation");
  const minimum =
    MODEL_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS[PI_MEMORY_STAGE1_MODEL];
  if (minimum === undefined) {
    throw new Error("Pi memory Stage 1 pricing threshold is missing");
  }
  const longContext = input + cacheRead + cacheCreation >= minimum;
  const category = (base: UsageCategoryBase): UsageCategory => {
    return longContext ? `${base}.long_context` : base;
  };
  return [
    { category: category("tokens.input"), quantity: input },
    { category: category("tokens.output"), quantity: output },
    { category: category("tokens.cache_read"), quantity: cacheRead },
    {
      category: category("tokens.cache_creation"),
      quantity: cacheCreation,
    },
  ].filter((entry) => {
    return entry.quantity > 0;
  });
}

function idempotencyKey(
  args: RecordPiMemoryStage1UsageArgs,
  category: UsageCategory,
): string {
  return uuidv5(
    JSON.stringify([
      args.memoryStorageId,
      args.piSessionId,
      args.sourceHistoryHash,
      args.responseSourceId,
      category,
    ]),
    PI_MEMORY_STAGE1_USAGE_NAMESPACE,
  );
}

/**
 * Persist background extraction usage independently from every foreground run.
 * Conflict validation makes the deterministic namespace fail closed.
 */
export async function recordPiMemoryStage1Usage(
  db: Db,
  args: RecordPiMemoryStage1UsageArgs,
): Promise<void> {
  const expected = usageEntries(args.usage).map((entry) => {
    return {
      runId: null,
      billingContext: "runless",
      idempotencyKey: idempotencyKey(args, entry.category),
      orgId: args.orgId,
      userId: args.userId,
      kind: "model",
      provider: PI_MEMORY_STAGE1_MODEL,
      category: entry.category,
      quantity: entry.quantity,
    } as const;
  });
  if (expected.length === 0) {
    return;
  }
  await db.transaction(async (tx) => {
    await tx
      .insert(usageEvent)
      .values(expected)
      .onConflictDoNothing({ target: [usageEvent.idempotencyKey] });
    const stored = await tx
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
          expected.map((row) => {
            return row.idempotencyKey;
          }),
        ),
      );
    const remaining = new Map(
      expected.map((row) => {
        return [row.idempotencyKey, row] as const;
      }),
    );
    for (const row of stored) {
      const wanted = remaining.get(row.idempotencyKey);
      if (
        !wanted ||
        row.runId !== null ||
        row.orgId !== wanted.orgId ||
        row.userId !== wanted.userId ||
        row.kind !== wanted.kind ||
        row.provider !== wanted.provider ||
        row.category !== wanted.category ||
        row.quantity !== wanted.quantity
      ) {
        throw new Error("Pi memory Stage 1 usage identity collision");
      }
      remaining.delete(row.idempotencyKey);
    }
    if (remaining.size > 0) {
      throw new Error("Pi memory Stage 1 usage persistence is incomplete");
    }
  });
}
