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
