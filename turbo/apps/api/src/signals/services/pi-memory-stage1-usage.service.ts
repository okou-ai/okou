import type { PiMemoryStage1Billing } from "./pi-memory-stage1-credential.service";
import { usageEvent } from "@okouai/db/schema/usage-event";
import type {
  PiMemoryStage1Model,
  PiMemoryStage1ProviderUsage,
} from "@okouai/pi-agent-runtime/api";
import { inArray, sql } from "drizzle-orm";
import { command } from "ccstate";
import { v5 as uuidv5 } from "uuid";

import { writeDb$ } from "../external/db";

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

export interface RecordPiMemoryStage1UsageArgs {
  readonly memoryStorageId: string;
  readonly piSessionId: string;
  readonly sourceHistoryHash: string;
  readonly model: PiMemoryStage1Model;
  readonly billing: PiMemoryStage1Billing;
  /**
   * The credential's captured catalog long-context threshold (null: single
   * tier).
   */
  readonly longContextMinTotalInputTokens: number | null;
  readonly responseSourceId: string;
  readonly usage: PiMemoryStage1ProviderUsage;
}

function quantity(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Pi memory Stage 1 ${field} usage is invalid`);
  }
  return value;
}

/**
 * Classify extraction usage with the same catalog threshold a foreground run
 * captures from its route: total input (input + cache read + cache creation)
 * at or above it bills the `.long_context` categories.
 */
export function piMemoryStage1UsageEntries(
  usage: PiMemoryStage1ProviderUsage,
  longContextMinTotalInputTokens: number | null,
): UsageEntry[] {
  const input = quantity(usage.input, "input");
  const output = quantity(usage.output, "output");
  const cacheRead = quantity(usage.cacheRead, "cache-read");
  const cacheCreation = quantity(usage.cacheWrite, "cache-creation");
  const longContext =
    longContextMinTotalInputTokens !== null &&
    input + cacheRead + cacheCreation >= longContextMinTotalInputTokens;
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
  ];
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
export const recordPiMemoryStage1Usage$ = command(
  async (
    { set },
    args: RecordPiMemoryStage1UsageArgs,
  ): Promise<PiMemoryStage1UsageReceipt> => {
    // Personal subscription usage is never a model-credit event, including replay/zero usage.
    if (args.billing.mode !== "builtin") {
      return { disposition: "subscription", accountingAt: null };
    }
    const expected = piMemoryStage1UsageEntries(
      args.usage,
      args.longContextMinTotalInputTokens,
    )
      .filter((entry) => {
        return entry.quantity > 0;
      })
      .map((entry) => {
        return {
          runId: null,
          billingRunId: null,
          createdAt: sql`now()`,
          billingAnchorAt: sql`now()`,
          billingContext: "pi_memory_stage1",
          idempotencyKey: idempotencyKey(args, entry.category),
          orgId: args.billing.orgId,
          userId: args.billing.userId,
          kind: "model",
          provider: args.model,
          category: entry.category,
          quantity: entry.quantity,
        } as const;
      });
    if (expected.length === 0) {
      return { disposition: "zero_usage", accountingAt: null };
    }
    return await set(writeDb$).transaction(async (tx) => {
      const inserted = await tx
        .insert(usageEvent)
        .values(expected)
        .onConflictDoNothing({ target: [usageEvent.idempotencyKey] })
        .returning({ id: usageEvent.id });
      const stored = await tx
        .select({
          idempotencyKey: usageEvent.idempotencyKey,
          runId: usageEvent.runId,
          billingRunId: usageEvent.billingRunId,
          billingContext: usageEvent.billingContext,
          billingAnchorAt: usageEvent.billingAnchorAt,
          createdAt: usageEvent.createdAt,
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
      // #34267 explicitly protects retained pre-D billing rows. Under #33892,
      // remove legacy replay handling only after old serving/rollback writers
      // retire and their raw keys drain; never retag historical charges.
      for (const row of stored) {
        const wanted = remaining.get(row.idempotencyKey);
        if (
          !wanted ||
          [row.runId, row.billingRunId].some((id) => {
            return id !== null;
          }) ||
          !["runless", "pi_memory_stage1"].includes(row.billingContext) ||
          row.billingAnchorAt?.getTime() !== row.createdAt.getTime() ||
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
      const first = stored[0];
      if (
        !first ||
        remaining.size > 0 ||
        (inserted.length !== 0 && inserted.length !== expected.length) ||
        stored.some((row) => {
          return (
            row.billingContext !== first.billingContext ||
            row.createdAt.getTime() !== first.createdAt.getTime()
          );
        })
      ) {
        throw new Error("Pi memory Stage 1 usage identity collision");
      }
      return {
        accountingAt: first.createdAt.toISOString(),
        disposition:
          inserted.length > 0
            ? "new"
            : first.billingContext === "runless"
              ? "legacy_replay"
              : "replay",
      };
    });
  },
);

export interface PiMemoryStage1UsageReceipt {
  readonly accountingAt: string | null;
  readonly disposition:
    | "new"
    | "replay"
    | "legacy_replay"
    | "zero_usage"
    | "subscription";
}

/** Opaque logical response identity; category delivery/outcome is not identity. */
export function piMemoryStage1AccountingId(
  args: RecordPiMemoryStage1UsageArgs,
): string {
  return uuidv5(
    JSON.stringify([
      args.memoryStorageId,
      args.piSessionId,
      args.sourceHistoryHash,
      args.responseSourceId,
    ]),
    PI_MEMORY_STAGE1_USAGE_NAMESPACE,
  );
}
