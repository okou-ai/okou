import { and, asc, eq, ne } from "drizzle-orm";
import {
  getBuiltInRouteProviderVendor,
  modelProviderTypeSchema,
  type ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
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

/**
 * Operators change a model's free-plan Built-in policy directly in the
 * database. Returns the restore of the previous value.
 */
export async function updateRestrictedPlanAccessFixture(args: {
  readonly model: string;
  readonly builtInOnRestrictedPlans: boolean;
}): Promise<() => Promise<void>> {
  const [previous] = await db()
    .select({
      builtInOnRestrictedPlans: runModelCatalog.builtInOnRestrictedPlans,
    })
    .from(runModelCatalog)
    .where(eq(runModelCatalog.model, args.model));
  if (!previous) {
    throw new Error("Expected one catalog model to be updated");
  }
  await db()
    .update(runModelCatalog)
    .set({ builtInOnRestrictedPlans: args.builtInOnRestrictedPlans })
    .where(eq(runModelCatalog.model, args.model));
  return async () => {
    await db()
      .update(runModelCatalog)
      .set({ builtInOnRestrictedPlans: previous.builtInOnRestrictedPlans })
      .where(eq(runModelCatalog.model, args.model));
  };
}

/** The model's first-priority eligible Built-in route in the catalog. */
export async function readPrimaryBuiltInRouteFixture(model: string): Promise<{
  readonly concreteProviderType: ModelProviderType;
  readonly upstreamModel: string;
  readonly vendor: string;
}> {
  const [route] = await db()
    .select({
      concreteProviderType: modelRoutes.concreteProviderType,
      upstreamModel: modelRoutes.upstreamModel,
    })
    .from(modelRoutes)
    .where(
      and(
        eq(modelRoutes.model, model),
        eq(modelRoutes.providerType, "built-in"),
        eq(modelRoutes.enabled, true),
        ne(modelRoutes.concreteProviderType, "deepseek"),
      ),
    )
    .orderBy(asc(modelRoutes.priority))
    .limit(1);
  const vendor = route
    ? getBuiltInRouteProviderVendor(route.concreteProviderType)
    : undefined;
  const concreteProviderType = modelProviderTypeSchema.safeParse(
    route?.concreteProviderType,
  );
  if (!route || !vendor || !concreteProviderType.success) {
    throw new Error(`Expected an enabled Built-in route for ${model}`);
  }
  return {
    concreteProviderType: concreteProviderType.data,
    upstreamModel: route.upstreamModel,
    vendor,
  };
}
