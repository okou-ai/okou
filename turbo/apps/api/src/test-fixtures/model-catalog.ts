import { eq } from "drizzle-orm";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { runModelCatalog } from "@okouai/db/schema/run-model-catalog";
import { db } from "../lib/db";

/**
 * Operators switch the system default directly in the database. Clear the old
 * default before setting the new one, as the partial unique index requires.
 */
export async function setModelCatalogSystemDefaultFixture(
  model: string,
): Promise<() => Promise<void>> {
  const [previous] = await db()
    .select({ model: runModelCatalog.model })
    .from(runModelCatalog)
    .where(eq(runModelCatalog.isSystemDefault, true));
  const swap = async (from: string | undefined, to: string) => {
    await db().transaction(async (tx) => {
      if (from) {
        await tx
          .update(runModelCatalog)
          .set({ isSystemDefault: false })
          .where(eq(runModelCatalog.model, from));
      }
      await tx
        .update(runModelCatalog)
        .set({ isSystemDefault: true })
        .where(eq(runModelCatalog.model, to));
    });
  };
  await swap(previous?.model, model);
  return async () => {
    if (previous) {
      await swap(model, previous.model);
    }
  };
}

async function lineageRankOf(model: string): Promise<number> {
  const [row] = await db()
    .select({ lineageRank: runModelCatalog.lineageRank })
    .from(runModelCatalog)
    .where(eq(runModelCatalog.model, model));
  if (!row) {
    throw new Error(`Expected catalog model ${model}`);
  }
  return row.lineageRank;
}

/**
 * Operators retire a model directly in the database: raise the replacement's
 * lineage rank above the retired model's first when needed, then set both
 * replacement columns in one statement. The returned restore clears the
 * replacement before lowering the rank back.
 */
export async function stageModelReplacementFixture(
  model: string,
  replacement: string,
): Promise<() => Promise<void>> {
  const retiredRank = await lineageRankOf(model);
  const originalReplacementRank = await lineageRankOf(replacement);
  const replacementRank = Math.max(originalReplacementRank, retiredRank + 1);
  if (replacementRank !== originalReplacementRank) {
    await db()
      .update(runModelCatalog)
      .set({ lineageRank: replacementRank })
      .where(eq(runModelCatalog.model, replacement));
  }
  await db()
    .update(runModelCatalog)
    .set({ replacedBy: replacement, replacedByLineageRank: replacementRank })
    .where(eq(runModelCatalog.model, model));
  return async () => {
    await db()
      .update(runModelCatalog)
      .set({ replacedBy: null, replacedByLineageRank: null })
      .where(eq(runModelCatalog.model, model));
    if (replacementRank !== originalReplacementRank) {
      await db()
        .update(runModelCatalog)
        .set({ lineageRank: originalReplacementRank })
        .where(eq(runModelCatalog.model, replacement));
    }
  };
}

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
