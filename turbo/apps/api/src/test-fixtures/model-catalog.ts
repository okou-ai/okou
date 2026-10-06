import { and, eq } from "drizzle-orm";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { modelRoutes } from "@okouai/db/schema/model-route";
import { runModelCatalog } from "@okouai/db/schema/run-model-catalog";
import type { PiRouteClass } from "@okouai/api-contracts/contracts/model-catalog";

import { db } from "../lib/db";

/** One retired row of a temporary replacement chain. */
export interface RetiredCatalogRowFixture {
  readonly model: string;
  readonly displayName: string;
  readonly sortOrder: number;
  readonly lineageRank: number;
  readonly replacedBy: string;
}

/**
 * Operators insert retired catalog rows directly in the database. Rows are
 * inserted in the given order, so each row's target must already exist; the
 * returned restore deletes them in reverse order, referrers first.
 */
export async function insertRetiredCatalogRowsFixture(
  rows: readonly RetiredCatalogRowFixture[],
): Promise<() => Promise<void>> {
  // One transaction: a failed insert leaves no partial chain behind.
  await db().transaction(async (tx) => {
    for (const row of rows) {
      const [target] = await tx
        .select({ lineageRank: runModelCatalog.lineageRank })
        .from(runModelCatalog)
        .where(eq(runModelCatalog.model, row.replacedBy));
      if (!target) {
        throw new Error(`Expected catalog model ${row.replacedBy}`);
      }
      await tx.insert(runModelCatalog).values({
        model: row.model,
        displayName: row.displayName,
        sortOrder: row.sortOrder,
        lineageRank: row.lineageRank,
        replacedBy: row.replacedBy,
        replacedByLineageRank: target.lineageRank,
      });
    }
  });
  return async () => {
    for (const row of [...rows].reverse()) {
      await db()
        .delete(runModelCatalog)
        .where(eq(runModelCatalog.model, row.model));
    }
  };
}

/**
 * A thread selection of a retired model cannot be written through the API: the
 * API resolves every new selection to the final active model. It exists only
 * as legacy stored data, so this fixture stages it directly on the thread row
 * (the documented exception for states impossible to construct through the
 * API).
 */
export async function stageLegacyChatThreadSelectedModelFixture(args: {
  readonly threadId: string;
  readonly model: string;
}): Promise<void> {
  const updated = await db()
    .update(chatThreads)
    .set({ selectedModel: args.model })
    .where(eq(chatThreads.id, args.threadId))
    .returning({ id: chatThreads.id });
  if (updated.length !== 1) {
    throw new Error("Expected one chat thread selection to be staged");
  }
}

/**
 * Operators set a Built-in route's long-context pricing threshold directly in
 * the database. The returned restore puts the previous threshold back.
 */
export async function setBuiltInRouteLongContextThresholdFixture(args: {
  readonly model: string;
  readonly concreteProviderType: string;
  readonly longContextMinTotalInputTokens: number | null;
}): Promise<() => Promise<void>> {
  const where = and(
    eq(modelRoutes.model, args.model),
    eq(modelRoutes.providerType, "built-in"),
    eq(modelRoutes.concreteProviderType, args.concreteProviderType),
  );
  const [previous] = await db()
    .select({ threshold: modelRoutes.longContextMinTotalInputTokens })
    .from(modelRoutes)
    .where(where);
  if (!previous) {
    throw new Error("Expected one Built-in route to set a threshold on");
  }
  await db()
    .update(modelRoutes)
    .set({
      longContextMinTotalInputTokens: args.longContextMinTotalInputTokens,
    })
    .where(where);
  return async () => {
    await db()
      .update(modelRoutes)
      .set({ longContextMinTotalInputTokens: previous.threshold })
      .where(where);
  };
}

/** The model's Pi admission projection from the current database catalog. */

/**
 * Operators set a model's Pi route class directly in the database. The
 * returned restore puts the previous class back.
 */
export async function setModelPiRouteClassFixture(
  model: string,
  piRouteClass: PiRouteClass | null,
): Promise<() => Promise<void>> {
  const [previous] = await db()
    .select({ piRouteClass: runModelCatalog.piRouteClass })
    .from(runModelCatalog)
    .where(eq(runModelCatalog.model, model));
  if (!previous) {
    throw new Error(`Expected catalog model ${model}`);
  }
  await db()
    .update(runModelCatalog)
    .set({ piRouteClass })
    .where(eq(runModelCatalog.model, model));
  return async () => {
    await db()
      .update(runModelCatalog)
      .set({ piRouteClass: previous.piRouteClass })
      .where(eq(runModelCatalog.model, model));
  };
}
