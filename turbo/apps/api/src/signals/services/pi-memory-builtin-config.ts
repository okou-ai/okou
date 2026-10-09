import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { usagePricing } from "@okouai/db/schema/usage-pricing";
import {
  resolveUsagePricingProvider,
  type UsagePricingResolution,
} from "../context/usage-pricing-resolution";
import {
  builtInRoutePricingFromSnapshot,
  usagePricingByKey,
} from "./built-in-route-pricing";
import {
  catalogBuiltInRoute,
  ModelCatalogInvariantError,
  type ModelCatalog,
} from "./model-catalog.service";
import { PI_MEMORY_STAGE1_BUILT_IN_MODEL } from "@okouai/pi-agent-runtime/api";
import { and, eq } from "drizzle-orm";
import { db$ } from "../external/db";
import { command } from "ccstate";
import type { ResolvedModelProviderEnvironment } from "./agent-run-contracts";
import type { BuiltInModelRuntimeRoute } from "./built-in-model-runtime-route.service";
import { compileModelRuntime } from "./execution-model-runtime";
import type { ModelSourceSnapshot } from "./execution-model-source.service";

export const readPiMemoryBuiltinPricing$ = command(
  async (
    { get },
    catalog: ModelCatalog,
    resolution: UsagePricingResolution,
  ) => {
    const route = catalogBuiltInRoute(
      catalog,
      PI_MEMORY_BUILTIN_BINDING.selectedModel,
      PI_MEMORY_BUILTIN_BINDING.providerType,
    );
    if (!route?.pricingKind || !route.pricingProvider) {
      throw new ModelCatalogInvariantError(
        "Pi memory pricing binding is missing",
      );
    }
    const rows = await get(db$)
      .select({
        kind: usagePricing.kind,
        provider: usagePricing.provider,
        category: usagePricing.category,
      })
      .from(usagePricing)
      .where(
        and(
          eq(usagePricing.kind, route.pricingKind),
          eq(
            usagePricing.provider,
            resolveUsagePricingProvider(
              resolution,
              route.pricingKind,
              route.pricingProvider,
            ),
          ),
        ),
      );
    return builtInRoutePricingFromSnapshot(
      { resolution, serviceTier: undefined },
      usagePricingByKey(rows),
    );
  },
);

/** Internal maintenance binding. This is never a foreground model candidate. */
export const PI_MEMORY_BUILTIN_BINDING = {
  selectedModel: PI_MEMORY_STAGE1_BUILT_IN_MODEL,
  providerType: "openrouter-codex",
  upstreamModel: `openai/${PI_MEMORY_STAGE1_BUILT_IN_MODEL}`,
} as const;

/** Fixed read owner for the internal route, without foreground default selection. */
export const resolvePiMemoryBuiltinRoute$ = command(
  async (
    { get },
    signal: AbortSignal,
  ): Promise<BuiltInModelRuntimeRoute | null> => {
    const [key] = await get(db$)
      .select({ id: builtInModelKeys.id, apiKey: builtInModelKeys.apiKey })
      .from(builtInModelKeys)
      .where(eq(builtInModelKeys.vendor, "openrouter"))
      .limit(1);
    signal.throwIfAborted();
    return key?.apiKey.trim()
      ? { ...PI_MEMORY_BUILTIN_BINDING, modelKeyId: key.id }
      : null;
  },
);

export function preparePiMemoryBuiltinEnvironment(
  source: ModelSourceSnapshot,
  route: BuiltInModelRuntimeRoute | undefined,
): ResolvedModelProviderEnvironment | null {
  if (
    source.identity.kind !== "built-in" ||
    !route ||
    route.modelKeyId !== source.identity.modelKeyId ||
    route.selectedModel !== PI_MEMORY_BUILTIN_BINDING.selectedModel ||
    route.providerType !== PI_MEMORY_BUILTIN_BINDING.providerType ||
    route.upstreamModel !== PI_MEMORY_BUILTIN_BINDING.upstreamModel
  ) {
    return null;
  }
  const credential = source.credentials.find((item) => {
    return (
      item.kind === "managed-key" &&
      item.modelKeyId === route.modelKeyId &&
      item.name === "OPENROUTER_API_KEY"
    );
  });
  if (
    !credential ||
    credential.kind !== "managed-key" ||
    !credential.apiKey.trim()
  ) {
    return null;
  }
  const compiled = compileModelRuntime({
    source,
    selection: { kind: "built-in", ...route },
    credentials: { OPENROUTER_API_KEY: credential.apiKey },
  });
  return {
    id: null,
    type: "built-in",
    credentialOwner: "builtin",
    concreteType: route.providerType,
    selectedModel: route.selectedModel,
    upstreamModel: route.upstreamModel,
    builtInModelRuntimeRoute: route,
    environment: { ...compiled.environment },
    secrets: { ...compiled.secrets },
  };
}
