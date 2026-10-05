import { and, eq } from "drizzle-orm";
import { modelRoutes } from "@okouai/db/schema/model-route";
import { runModelCatalog } from "@okouai/db/schema/run-model-catalog";
import { db } from "../lib/db";

/** Create a unique operator-owned personal catalog entry without changing shared routes. */
export async function insertSubscriptionRouteCapabilitiesFixture(
  model: string,
): Promise<() => Promise<void>> {
  await db().transaction(async (tx) => {
    await tx.insert(runModelCatalog).values({
      model,
      displayName: "Subscription capabilities",
      sortOrder: 100_000,
      lineageRank: 0,
    });
    await tx.insert(modelRoutes).values({
      model,
      providerType: "codex-oauth-token",
      concreteProviderType: "codex-oauth-token",
      subscriptionType: "codex-oauth-token",
      upstreamModel: "gpt-6-luna",
      priority: 0,
      efforts: ["low", "high"],
      defaultEffort: "high",
      serviceTiers: [],
    });
  });
  return async () => {
    await db().transaction(async (tx) => {
      await tx
        .delete(modelRoutes)
        .where(
          and(
            eq(modelRoutes.model, model),
            eq(modelRoutes.subscriptionType, "codex-oauth-token"),
          ),
        );
      await tx.delete(runModelCatalog).where(eq(runModelCatalog.model, model));
    });
  };
}
