import { getModelProviderFirewall } from "@okouai/api-contracts/contracts/model-providers";
import { getOpenRouterBaseUrl } from "@okouai/api-contracts/contracts/openrouter-routing";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { builtInModelCandidateCooldown } from "@okouai/db/schema/built-in-model-cooldown";
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
import { and, eq, gt } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import type { ReadonlyDb } from "../external/db";
import type { ResolvedModelProviderEnvironment } from "./agent-run-contracts";
import type { BuiltInModelRuntimeRoute } from "./built-in-model-runtime-route.service";
import { compileModelRuntime } from "./execution-model-runtime";
import type { ModelSourceSnapshot } from "./execution-model-source.service";

export async function readPiMemoryBuiltinPricing(
  db: ReadonlyDb,
  catalog: ModelCatalog,
  resolution: UsagePricingResolution,
) {
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
  const rows = await db
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
}

/** Internal maintenance binding. This is never a foreground model candidate. */
export const PI_MEMORY_BUILTIN_BINDING = {
  selectedModel: PI_MEMORY_STAGE1_BUILT_IN_MODEL,
  providerType: "openrouter-codex",
  upstreamModel: `deepseek/${PI_MEMORY_STAGE1_BUILT_IN_MODEL}`,
} as const;

export async function resolvePiMemoryBuiltinRoute(
  db: ReadonlyDb,
  signal: AbortSignal,
): Promise<BuiltInModelRuntimeRoute | null> {
  const [key] = await db
    .select({ id: builtInModelKeys.id, apiKey: builtInModelKeys.apiKey })
    .from(builtInModelKeys)
    .where(eq(builtInModelKeys.vendor, "openrouter"))
    .limit(1);
  signal.throwIfAborted();
  if (!key?.apiKey.trim()) {
    return null;
  }
  const [cooldown] = await db
    .select({ id: builtInModelCandidateCooldown.selectedModel })
    .from(builtInModelCandidateCooldown)
    .where(
      and(
        eq(
          builtInModelCandidateCooldown.selectedModel,
          PI_MEMORY_BUILTIN_BINDING.selectedModel,
        ),
        eq(
          builtInModelCandidateCooldown.modelRuntimeProvider,
          PI_MEMORY_BUILTIN_BINDING.providerType,
        ),
        eq(
          builtInModelCandidateCooldown.modelRuntimeModel,
          PI_MEMORY_BUILTIN_BINDING.upstreamModel,
        ),
        gt(builtInModelCandidateCooldown.unavailableUntil, nowDate()),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return cooldown ? null : { ...PI_MEMORY_BUILTIN_BINDING, modelKeyId: key.id };
}

export function preparePiMemoryBuiltinEnvironment(
  source: ModelSourceSnapshot,
  route: BuiltInModelRuntimeRoute | undefined,
  featureSwitchContext: FeatureSwitchContext,
): ResolvedModelProviderEnvironment | null {
  if (
    source.identity.kind !== "built-in" ||
    source.credentialOwner !== "builtin" ||
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
  const routing = {
    credentialOwner: "builtin" as const,
    model: route.upstreamModel,
    usRoutingEnabled: isFeatureEnabled(
      FeatureSwitchKey.OpenRouterUsRouting,
      featureSwitchContext,
    ),
  };
  return {
    id: null,
    type: "built-in",
    credentialOwner: "builtin",
    concreteType: route.providerType,
    selectedModel: route.selectedModel,
    upstreamModel: route.upstreamModel,
    builtInModelRuntimeRoute: route,
    environment: {
      ...compiled.environment,
      OPENAI_BASE_URL: getOpenRouterBaseUrl("responses", routing),
    },
    secrets: { ...compiled.secrets },
    firewall: getModelProviderFirewall(route.providerType, routing),
  };
}
