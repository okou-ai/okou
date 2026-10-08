import { eq } from "drizzle-orm";
import { runModelCatalog } from "@okouai/db/schema/run-model-catalog";
import type { PiRouteClass } from "@okouai/api-contracts/contracts/model-catalog";

import { db } from "../lib/db";

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
