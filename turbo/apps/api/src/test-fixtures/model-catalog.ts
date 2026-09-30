import { eq } from "drizzle-orm";
import { runModelCatalog } from "@okouai/db/schema/run-model-catalog";
import { db } from "../lib/db";

/**
 * Operators manage the catalog directly; no API writes it. Stage a catalog
 * without a system default to prove the reader fails loudly instead of
 * choosing one.
 */
export async function clearModelCatalogSystemDefaultFixture(): Promise<
  () => Promise<void>
> {
  const cleared = await db()
    .update(runModelCatalog)
    .set({ isSystemDefault: false })
    .where(eq(runModelCatalog.isSystemDefault, true))
    .returning({ model: runModelCatalog.model });
  return async () => {
    for (const row of cleared) {
      await db()
        .update(runModelCatalog)
        .set({ isSystemDefault: true })
        .where(eq(runModelCatalog.model, row.model));
    }
  };
}

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
