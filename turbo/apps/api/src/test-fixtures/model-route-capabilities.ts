import { and, asc, eq } from "drizzle-orm";
import {
  modelProviderTypeSchema,
  type ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  AUTO_RUN_KEY_VENDOR,
  AUTO_RUN_PROVIDER,
} from "@okouai/core/auto-run-model";
import { modelRoutes } from "@okouai/db/schema/model-route";
import { db } from "../lib/db";

/** Operators change a model's route capabilities directly in the database. */
export async function updateModelRouteCapabilitiesFixture(args: {
  readonly model: string;
  readonly efforts: readonly string[];
  readonly defaultEffort: string | null;
  readonly serviceTiers: readonly "priority"[];
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
      ),
    )
    .orderBy(asc(modelRoutes.priority))
    .limit(1);
  const vendor =
    route?.concreteProviderType === AUTO_RUN_PROVIDER
      ? AUTO_RUN_KEY_VENDOR
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
