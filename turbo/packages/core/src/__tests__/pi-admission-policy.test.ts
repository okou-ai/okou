import { describe, expect, it } from "vitest";
import {
  isFrontierModelProductLine,
  modelProductLine,
} from "../model-product-line";
import {
  isPiExecutionRoute,
  isPiPolicyAdmittedRoute,
  isPiRouteRuntimeCapable,
  piCatalogModel,
  piRouteCatalogIdentities,
  type PiExecutionRouteArgs,
} from "../pi-execution";
import { PI_RUNTIME_RESOLVABLE_MODELS } from "../pi-runtime-capability";
import {
  SEEDED_MODEL_CATALOG,
  SEEDED_ROUTED_MODELS,
  seededProviderTypes,
} from "./seeded-model-catalog";

/**
 * Every routed catalog model against every provider type of its enabled
 * seeded `model_routes` plus both custom gateways, for each
 * runtime route the Built-in vendor picker can land on and both Codex service
 * tiers.
 *
 * `EXPECTED_ADMITTED_ROUTES` is the admission decision this repository
 * currently records for that enumeration, not a frozen copy of an earlier
 * branch. It started as what main @ 3938412 produced and was moved once, by
 * #35905, which returned the Fable frontier line to the Claude Code vendor
 * harness and removed its 18 routes. Pi 0.87.1 admits Opus 5.5 and GPT 6 Sol
 * and Luna through their catalog-resolved routes. Editing this list is how an
 * admission change is recorded, so a diff here must come with the decision — an
 * unexplained diff is a regression.
 */
const EXPECTED_ADMITTED_ROUTES = [
  "okou-1.0 | built-in | built-in | standard",
  "okou-1.0 | built-in | openrouter-codex | standard",
  "claude-opus-5-5 | built-in | built-in | standard",
  "claude-opus-5-5 | built-in | built-in | fast",
  "claude-opus-5-5 | built-in | anthropic-api-key | standard",
  "claude-opus-5-5 | built-in | anthropic-api-key | fast",
  "claude-opus-5-5 | built-in | openrouter-api-key | standard",
  "claude-opus-5-5 | built-in | openrouter-api-key | fast",
  "claude-opus-5-5 | anthropic-api-key | anthropic-api-key | standard",
  "claude-opus-5-5 | anthropic-api-key | anthropic-api-key | fast",
  "claude-opus-5-5 | openrouter-api-key | openrouter-api-key | standard",
  "claude-opus-5-5 | openrouter-api-key | openrouter-api-key | fast",
  "claude-opus-5-5 | vercel-ai-gateway | vercel-ai-gateway | standard",
  "claude-opus-5-5 | vercel-ai-gateway | vercel-ai-gateway | fast",
  "claude-opus-5-5 | azure-foundry | azure-foundry | standard",
  "claude-opus-5-5 | azure-foundry | azure-foundry | fast",
  "claude-opus-5-5 | aws-bedrock | aws-bedrock | standard",
  "claude-opus-5-5 | aws-bedrock | aws-bedrock | fast",
  "claude-opus-5-5 | custom-anthropic-messages | custom-anthropic-messages | standard",
  "claude-opus-5-5 | custom-anthropic-messages | custom-anthropic-messages | fast",
  "claude-opus-5 | built-in | built-in | standard",
  "claude-opus-5 | built-in | built-in | fast",
  "claude-opus-5 | built-in | anthropic-api-key | standard",
  "claude-opus-5 | built-in | anthropic-api-key | fast",
  "claude-opus-5 | built-in | openrouter-api-key | standard",
  "claude-opus-5 | built-in | openrouter-api-key | fast",
  "claude-opus-5 | anthropic-api-key | anthropic-api-key | standard",
  "claude-opus-5 | anthropic-api-key | anthropic-api-key | fast",
  "claude-opus-5 | openrouter-api-key | openrouter-api-key | standard",
  "claude-opus-5 | openrouter-api-key | openrouter-api-key | fast",
  "claude-opus-5 | vercel-ai-gateway | vercel-ai-gateway | standard",
  "claude-opus-5 | vercel-ai-gateway | vercel-ai-gateway | fast",
  "claude-opus-5 | azure-foundry | azure-foundry | standard",
  "claude-opus-5 | azure-foundry | azure-foundry | fast",
  "claude-opus-5 | aws-bedrock | aws-bedrock | standard",
  "claude-opus-5 | aws-bedrock | aws-bedrock | fast",
  "claude-opus-5 | custom-anthropic-messages | custom-anthropic-messages | standard",
  "claude-opus-5 | custom-anthropic-messages | custom-anthropic-messages | fast",
  "claude-sonnet-5-5 | built-in | built-in | standard",
  "claude-sonnet-5-5 | built-in | built-in | fast",
  "claude-sonnet-5-5 | built-in | anthropic-api-key | standard",
  "claude-sonnet-5-5 | built-in | anthropic-api-key | fast",
  "claude-sonnet-5-5 | anthropic-api-key | anthropic-api-key | standard",
  "claude-sonnet-5-5 | anthropic-api-key | anthropic-api-key | fast",
  "claude-sonnet-5 | built-in | built-in | standard",
  "claude-sonnet-5 | built-in | built-in | fast",
  "claude-sonnet-5 | built-in | anthropic-api-key | standard",
  "claude-sonnet-5 | built-in | anthropic-api-key | fast",
  "claude-sonnet-5 | built-in | openrouter-api-key | standard",
  "claude-sonnet-5 | built-in | openrouter-api-key | fast",
  "claude-sonnet-5 | anthropic-api-key | anthropic-api-key | standard",
  "claude-sonnet-5 | anthropic-api-key | anthropic-api-key | fast",
  "claude-sonnet-5 | openrouter-api-key | openrouter-api-key | standard",
  "claude-sonnet-5 | openrouter-api-key | openrouter-api-key | fast",
  "claude-sonnet-5 | vercel-ai-gateway | vercel-ai-gateway | standard",
  "claude-sonnet-5 | vercel-ai-gateway | vercel-ai-gateway | fast",
  "claude-sonnet-5 | azure-foundry | azure-foundry | standard",
  "claude-sonnet-5 | azure-foundry | azure-foundry | fast",
  "claude-sonnet-5 | aws-bedrock | aws-bedrock | standard",
  "claude-sonnet-5 | aws-bedrock | aws-bedrock | fast",
  "claude-sonnet-5 | custom-anthropic-messages | custom-anthropic-messages | standard",
  "claude-sonnet-5 | custom-anthropic-messages | custom-anthropic-messages | fast",
  "gpt-6.1-sol | built-in | built-in | standard",
  "gpt-6.1-sol | built-in | openai-api-key | standard",
  "gpt-6.1-sol | built-in | openai-api-key | fast",
  "gpt-6.1-sol | openai-api-key | openai-api-key | standard",
  "gpt-6.1-sol | openai-api-key | openai-api-key | fast",
  "gpt-6.1-sol | codex-oauth-token | codex-oauth-token | standard",
  "gpt-6.1-sol | codex-oauth-token | codex-oauth-token | fast",
  "gpt-6-sol | built-in | built-in | standard",
  "gpt-6-sol | built-in | openai-api-key | standard",
  "gpt-6-sol | built-in | openai-api-key | fast",
  "gpt-6-sol | built-in | openrouter-codex | standard",
  "gpt-6-sol | built-in | openrouter-codex | fast",
  "gpt-6-sol | openai-api-key | openai-api-key | standard",
  "gpt-6-sol | openai-api-key | openai-api-key | fast",
  "gpt-6-sol | codex-oauth-token | codex-oauth-token | standard",
  "gpt-6-sol | codex-oauth-token | codex-oauth-token | fast",
  "gpt-6-sol | openrouter-codex | openrouter-codex | standard",
  "gpt-6-sol | openrouter-codex | openrouter-codex | fast",
  "gpt-6-sol | custom-openai-responses | custom-openai-responses | standard",
  "gpt-6-sol | custom-openai-responses | custom-openai-responses | fast",
  "gpt-6-luna | built-in | built-in | standard",
  "gpt-6-luna | built-in | openai-api-key | standard",
  "gpt-6-luna | built-in | openai-api-key | fast",
  "gpt-6-luna | built-in | openrouter-codex | standard",
  "gpt-6-luna | built-in | openrouter-codex | fast",
  "gpt-6-luna | openai-api-key | openai-api-key | standard",
  "gpt-6-luna | openai-api-key | openai-api-key | fast",
  "gpt-6-luna | codex-oauth-token | codex-oauth-token | standard",
  "gpt-6-luna | codex-oauth-token | codex-oauth-token | fast",
  "gpt-6-luna | openrouter-codex | openrouter-codex | standard",
  "gpt-6-luna | openrouter-codex | openrouter-codex | fast",
  "gpt-6-luna | custom-openai-responses | custom-openai-responses | standard",
  "gpt-6-luna | custom-openai-responses | custom-openai-responses | fast",
  "gpt-5.6-sol | built-in | built-in | standard",
  "gpt-5.6-sol | built-in | openai-api-key | standard",
  "gpt-5.6-sol | built-in | openai-api-key | fast",
  "gpt-5.6-sol | built-in | openrouter-codex | standard",
  "gpt-5.6-sol | built-in | openrouter-codex | fast",
  "gpt-5.6-sol | openai-api-key | openai-api-key | standard",
  "gpt-5.6-sol | openai-api-key | openai-api-key | fast",
  "gpt-5.6-sol | codex-oauth-token | codex-oauth-token | standard",
  "gpt-5.6-sol | codex-oauth-token | codex-oauth-token | fast",
  "gpt-5.6-sol | openrouter-codex | openrouter-codex | standard",
  "gpt-5.6-sol | openrouter-codex | openrouter-codex | fast",
  "gpt-5.6-sol | vercel-ai-gateway-codex | vercel-ai-gateway-codex | standard",
  "gpt-5.6-sol | vercel-ai-gateway-codex | vercel-ai-gateway-codex | fast",
  "gpt-5.6-sol | custom-openai-responses | custom-openai-responses | standard",
  "gpt-5.6-sol | custom-openai-responses | custom-openai-responses | fast",
  "gpt-5.6-luna | built-in | built-in | standard",
  "gpt-5.6-luna | built-in | openai-api-key | standard",
  "gpt-5.6-luna | built-in | openai-api-key | fast",
  "gpt-5.6-luna | built-in | openrouter-codex | standard",
  "gpt-5.6-luna | built-in | openrouter-codex | fast",
  "gpt-5.6-luna | openai-api-key | openai-api-key | standard",
  "gpt-5.6-luna | openai-api-key | openai-api-key | fast",
  "gpt-5.6-luna | codex-oauth-token | codex-oauth-token | standard",
  "gpt-5.6-luna | codex-oauth-token | codex-oauth-token | fast",
  "gpt-5.6-luna | openrouter-codex | openrouter-codex | standard",
  "gpt-5.6-luna | openrouter-codex | openrouter-codex | fast",
  "gpt-5.6-luna | vercel-ai-gateway-codex | vercel-ai-gateway-codex | standard",
  "gpt-5.6-luna | vercel-ai-gateway-codex | vercel-ai-gateway-codex | fast",
  "gpt-5.6-luna | custom-openai-responses | custom-openai-responses | standard",
  "gpt-5.6-luna | custom-openai-responses | custom-openai-responses | fast",
  "deepseek-v4.1-flash | built-in | deepseek | standard",
  "deepseek-v4.1-flash | built-in | deepseek | fast",
  "deepseek-v4.1-flash | built-in | openrouter-codex | standard",
  "deepseek-v4.1-flash | built-in | openrouter-codex | fast",
  "deepseek-v4.1-flash | openrouter-codex | openrouter-codex | standard",
  "deepseek-v4.1-flash | openrouter-codex | openrouter-codex | fast",
  "deepseek-v4.1-flash | custom-openai-responses | custom-openai-responses | standard",
  "deepseek-v4.1-flash | custom-openai-responses | custom-openai-responses | fast",
  "deepseek-v4-flash | built-in | deepseek | standard",
  "deepseek-v4-flash | built-in | deepseek | fast",
  "deepseek-v4-flash | built-in | openrouter-codex | standard",
  "deepseek-v4-flash | built-in | openrouter-codex | fast",
  "deepseek-v4-flash | deepseek | deepseek | standard",
  "deepseek-v4-flash | deepseek | deepseek | fast",
  "deepseek-v4-flash | openrouter-codex | openrouter-codex | standard",
  "deepseek-v4-flash | openrouter-codex | openrouter-codex | fast",
  "deepseek-v4-flash | custom-openai-responses | custom-openai-responses | standard",
  "deepseek-v4-flash | custom-openai-responses | custom-openai-responses | fast",
] as const;

/**
 * The enumeration is driven by the seeded catalog routes, so it
 * shrinks only when a model is retired or a route is removed. The remaining
 * 218 combinations are all evaluated.
 */
const ENUMERATED_COMBINATIONS = 230;

interface Combination {
  readonly selectedModel: string;
  readonly modelProviderType: string;
  readonly runtimeProviderType: string;
  readonly codexServiceTier: "fast" | undefined;
}

function label(combination: Combination): string {
  return [
    combination.selectedModel,
    combination.modelProviderType,
    combination.runtimeProviderType,
    combination.codexServiceTier ?? "standard",
  ].join(" | ");
}

function routeArgs(combination: Combination): PiExecutionRouteArgs {
  return {
    catalogModel: piCatalogModel(
      SEEDED_MODEL_CATALOG,
      combination.selectedModel,
    ),
    modelProviderType: combination.modelProviderType,
    runtimeProviderType: combination.runtimeProviderType,
    codexServiceTier: combination.codexServiceTier,
  };
}

function seededModelsWithRouteClass(
  routeClass: string | null,
): readonly string[] {
  return SEEDED_MODEL_CATALOG.models
    .filter((entry) => {
      return entry.piRouteClass === routeClass;
    })
    .map((entry) => {
      return entry.model;
    });
}

function seededBuiltInProviderTypes(selectedModel: string): readonly string[] {
  const model = piCatalogModel(SEEDED_MODEL_CATALOG, selectedModel);
  if (!model) {
    throw new Error(`Seeded catalog has no row for ${selectedModel}`);
  }
  return model.builtIn.map((route) => {
    return route.concreteProviderType;
  });
}

function enumerateCombinations(): readonly Combination[] {
  const combinations: Combination[] = [];
  for (const selectedModel of SEEDED_ROUTED_MODELS) {
    const providers = new Set<string>([
      ...seededProviderTypes(selectedModel),
      "custom-anthropic-messages",
      "custom-openai-responses",
    ]);
    for (const modelProviderType of providers) {
      const runtimes =
        modelProviderType === "built-in"
          ? ["built-in", ...seededBuiltInProviderTypes(selectedModel)]
          : [modelProviderType];
      for (const runtimeProviderType of runtimes) {
        for (const codexServiceTier of [undefined, "fast"] as const) {
          combinations.push({
            selectedModel,
            modelProviderType,
            runtimeProviderType,
            codexServiceTier,
          });
        }
      }
    }
  }
  return combinations;
}

describe("Pi route classes in the seeded catalog", () => {
  it("keeps the route classes credential capture and billing read", () => {
    // `agent-run-create.service.ts` captures a provider secret for the native
    // and DeepSeek classes, and the Pi usage services select API-owned billing
    // entries for the GPT class. Moving a model's `pi_route_class` moves those
    // decisions, so the sets are pinned here and not only through admission.
    expect(seededModelsWithRouteClass("claude-native")).toStrictEqual([
      "claude-opus-5-5",
      "claude-opus-5",
      "claude-sonnet-5-5",
      "claude-sonnet-5",
    ]);
    expect(seededModelsWithRouteClass("gpt-codex")).toStrictEqual([
      "okou-1.0",
      "gpt-6.1-sol",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-luna",
    ]);
    expect(seededModelsWithRouteClass("deepseek")).toStrictEqual([
      "deepseek-v4.1-flash",
      "deepseek-v4-flash",
    ]);
  });

  it("keeps every frontier product line on its vendor harness", () => {
    // The epic's rule, enforced on the catalog data rather than restated per
    // model: a frontier line runs on its vendor's harness. Seeding a Fable or
    // Astra model with a Pi route class fails here instead of quietly reaching
    // Pi.
    const frontier = SEEDED_MODEL_CATALOG.models.filter((entry) => {
      return isFrontierModelProductLine(entry.model);
    });
    // Without this the loop below would pass on an empty set, which is exactly
    // what a broken classifier produces.
    expect(
      frontier.map((entry) => {
        return entry.model;
      }),
    ).toStrictEqual(["claude-fable-5-1", "gpt-6-astra"]);
    for (const entry of frontier) {
      expect(entry.piRouteClass, entry.model).toBeNull();
    }
  });

  it("classifies every active model into a known product line", () => {
    // A model whose line is not recorded classifies as `null`, which would make
    // the frontier rule silently inapplicable to it. Failing here forces the
    // line into `MODEL_PRODUCT_LINES`, next to the frontier set, where the
    // vendor-harness question has to be answered.
    const unclassified = SEEDED_ROUTED_MODELS.filter((model) => {
      return modelProductLine(model) === null;
    });
    expect(unclassified).toStrictEqual([]);
  });
});

describe("Pi admission decisions", () => {
  it("admits exactly the recorded routes for every model and route", () => {
    const combinations = enumerateCombinations();
    expect(combinations).toHaveLength(ENUMERATED_COMBINATIONS);
    const admitted = combinations
      .filter((combination) => {
        return isPiExecutionRoute(routeArgs(combination));
      })
      .map(label)
      .sort();
    expect(admitted).toStrictEqual([...EXPECTED_ADMITTED_ROUTES].sort());
  });

  it("keeps claude-fable-5-1 on the vendor harness on every route", () => {
    // The Fable line left the Pi loop in #35905. Its routes stay in the
    // enumeration, so this names the model the slice moved and proves the
    // exclusion holds on every one of them rather than only on the absence of
    // rows above.
    const fableRoutes = enumerateCombinations().filter((combination) => {
      return combination.selectedModel === "claude-fable-5-1";
    });
    expect(fableRoutes.length).toBeGreaterThan(0);
    for (const combination of fableRoutes) {
      // Both layers, because the capability gate would refuse these routes on
      // its own now that the identity is gone. Asserting only the end result
      // would let the catalog silently readmit the line.
      expect(
        isPiPolicyAdmittedRoute(routeArgs(combination)),
        label(combination),
      ).toBe(false);
      expect(
        isPiExecutionRoute(routeArgs(combination)),
        label(combination),
      ).toBe(false);
    }
  });

  it.each([
    ["claude-opus-5-5", "anthropic-api-key"],
    ["gpt-6-sol", "openai-api-key"],
    ["gpt-6-luna", "openai-api-key"],
  ] as const)(
    "admits %s when its Pi 0.87.1 catalog route is available",
    (selectedModel, providerType) => {
      const route = {
        catalogModel: piCatalogModel(SEEDED_MODEL_CATALOG, selectedModel),
        modelProviderType: providerType,
        runtimeProviderType: providerType,
        codexServiceTier: undefined,
      };
      expect(isPiRouteRuntimeCapable(route)).toBe(true);
      expect(isPiExecutionRoute(route)).toBe(true);
    },
  );
});

describe("Pi runtime capability data", () => {
  it("carries exactly the identities admitted routes can request", () => {
    const requested = new Set<string>();
    for (const combination of enumerateCombinations()) {
      // Enumerated before the capability gate, so a missing entry cannot hide
      // by removing its own route from the comparison.
      if (!isPiPolicyAdmittedRoute(routeArgs(combination))) {
        continue;
      }
      for (const identity of piRouteCatalogIdentities(routeArgs(combination))) {
        requested.add(`${identity.provider} | ${identity.model}`);
      }
    }
    const declared = Object.entries(PI_RUNTIME_RESOLVABLE_MODELS).flatMap(
      ([provider, models]) => {
        return models.map((model) => {
          return `${provider} | ${model}`;
        });
      },
    );
    // The catalog lets any organization's custom Responses gateway serve
    // okou-1.0, so route rules admit it there; the pinned runtime cannot
    // resolve that identity, and the capability gate keeps the route off Pi.
    const capabilityRefused = ["openai | okou-1.0"];
    expect([...requested].sort()).toStrictEqual(
      [...declared, ...capabilityRefused].sort(),
    );
  });

  it("refuses okou-1.0 on a custom Responses gateway at the capability gate", () => {
    const route = {
      catalogModel: piCatalogModel(SEEDED_MODEL_CATALOG, "okou-1.0"),
      modelProviderType: "custom-openai-responses",
      runtimeProviderType: "custom-openai-responses",
      codexServiceTier: undefined,
    };
    expect(isPiPolicyAdmittedRoute(route)).toBe(true);
    expect(isPiRouteRuntimeCapable(route)).toBe(false);
  });
});
