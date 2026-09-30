import { eq } from "drizzle-orm";
import { modelRoutes } from "@okouai/db/schema/model-route";
import { runModelCatalog } from "@okouai/db/schema/run-model-catalog";
import { db } from "../lib/db";

/** Operators change a model's route capabilities directly in the database. */
export async function updateModelRouteCapabilitiesFixture(args: {
  readonly model: string;
  readonly efforts: readonly string[];
  readonly defaultEffort: string | null;
  readonly serviceTiers: readonly ("priority" | "ultrafast")[];
}): Promise<void> {
  const updated = await db()
    .update(modelRoutes)
    .set({
      efforts: [...args.efforts],
      defaultEffort: args.defaultEffort,
      serviceTiers: [...args.serviceTiers],
    })
    .where(eq(modelRoutes.model, args.model))
    .returning({ id: modelRoutes.id });
  if (updated.length === 0) {
    throw new Error("Expected the model to have catalog routes");
  }
}

/** Operators change a model's plan policy directly in the database. */
export async function updateRestrictedPlanAccessFixture(args: {
  readonly model: string;
  readonly builtInOnRestrictedPlans: boolean;
  readonly ownRoutesOnRestrictedPlans: boolean;
}): Promise<void> {
  const updated = await db()
    .update(runModelCatalog)
    .set({
      builtInOnRestrictedPlans: args.builtInOnRestrictedPlans,
      ownRoutesOnRestrictedPlans: args.ownRoutesOnRestrictedPlans,
    })
    .where(eq(runModelCatalog.model, args.model))
    .returning({ model: runModelCatalog.model });
  if (updated.length !== 1) {
    throw new Error("Expected one catalog model to be updated");
  }
}
