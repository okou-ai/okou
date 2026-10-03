import { randomUUID } from "node:crypto";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { modelRoutes } from "@okouai/db/schema/model-route";
import { and, eq } from "drizzle-orm";
import { onTestFinished } from "vitest";

import { db } from "../lib/db";
import {
  acquireBuiltInModelKeyFixture,
  releaseBuiltInModelKeyFixture,
} from "../signals/services/built-in-model-key-fixture";
import type { BuiltInModelRuntimeRoute } from "../signals/services/built-in-model-runtime-route.service";
import { PI_MEMORY_PHASE2_BUILT_IN_MODEL } from "../signals/services/pi-memory-phase2-usage.service";

/** Historical operator key: never an eligible new Built-in selection. */
export async function seedLegacyDirectMaintenanceKey(): Promise<void> {
  const fixtureId = randomUUID();
  await acquireBuiltInModelKeyFixture(db(), fixtureId, [
    { vendor: "deepseek", apiKey: `boundary-legacy-${fixtureId}` },
  ]);
  onTestFinished(() => {
    return releaseBuiltInModelKeyFixture(db(), fixtureId);
  });
}

/**
 * Read the still catalog-permitted route an older API could have captured.
 * Do not disable shared catalog rows or rewrite a dispatched execution context.
 */
export async function readLegacyDirectMaintenanceRoute(): Promise<BuiltInModelRuntimeRoute> {
  const [route] = await db()
    .select({ upstreamModel: modelRoutes.upstreamModel })
    .from(modelRoutes)
    .where(
      and(
        eq(modelRoutes.model, PI_MEMORY_PHASE2_BUILT_IN_MODEL),
        eq(modelRoutes.providerType, "built-in"),
        eq(modelRoutes.concreteProviderType, "deepseek"),
        eq(modelRoutes.enabled, true),
      ),
    );
  const [key] = await db()
    .select({ id: builtInModelKeys.id })
    .from(builtInModelKeys)
    .where(eq(builtInModelKeys.vendor, "deepseek"));
  if (!route || !key) {
    throw new Error("Missing catalog-permitted historical DeepSeek fixture");
  }
  return {
    selectedModel: PI_MEMORY_PHASE2_BUILT_IN_MODEL,
    providerType: "deepseek",
    upstreamModel: route.upstreamModel,
    modelKeyId: key.id,
  };
}
