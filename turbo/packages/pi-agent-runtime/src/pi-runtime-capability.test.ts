import { describe, expect, it } from "vitest";
import {
  isPiExecutionRoute,
  isPiAdmittedRoute,
  isPiRouteRuntimeCapable,
  piCatalogModel,
  piRouteCatalogIdentities,
  type PiExecutionRouteArgs,
} from "@okouai/core/pi-execution";
import {
  SEEDED_MODEL_CATALOG,
  SEEDED_ROUTED_MODELS,
  seededProviderTypes,
} from "@okouai/core/__tests__/seeded-model-catalog";
import {
  PI_CATALOG_PROVIDERS,
  PI_RUNTIME_RESOLVABLE_MODELS,
  type PiRuntimeIdentity,
} from "@okouai/core/pi-runtime-capability";
import { resolvePiAgentModel } from "./model";

/**
 * `@okouai/core/pi-execution` reaches the Platform browser bundle, so its
 * capability data cannot import the Pi SDK. This test is the other half of that
 * split: it runs the real resolver, which does see the pinned catalog and the
 * sanctioned hand-pinned definitions in `sourceModel`, and fails when the data
 * module and the runtime disagree about any admitted route.
 */
function resolvesInRuntime(identity: PiRuntimeIdentity): boolean {
  if (identity.provider === "openai-codex") {
    return (
      resolvePiAgentModel({
        dialect: "openai-codex-responses",
        transport: "sse",
        provider: "openai-codex",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        apiKey: "capability-probe",
        accountId: "capability-probe-account",
        model: identity.model,
      }) !== null
    );
  }
  return (
    resolvePiAgentModel({
      dialect: "openai-responses",
      transport: "sse",
      provider: identity.provider,
      baseUrl: "https://capability.probe.invalid",
      apiKey: "capability-probe",
      model: identity.model,
    }) !== null
  );
}

function declaredIdentities(): readonly PiRuntimeIdentity[] {
  return PI_CATALOG_PROVIDERS.flatMap((provider) => {
    return PI_RUNTIME_RESOLVABLE_MODELS[provider].map((model) => {
      return { provider, model };
    });
  });
}

interface AdmittedRoute {
  readonly selectedModel: string;
  readonly modelProviderType: string;
  readonly runtimeProviderType: string;
  readonly codexServiceTier: "fast" | undefined;
}

function routeArgs(route: AdmittedRoute): PiExecutionRouteArgs {
  return {
    catalogModel: piCatalogModel(SEEDED_MODEL_CATALOG, route.selectedModel),
    modelProviderType: route.modelProviderType,
    runtimeProviderType: route.runtimeProviderType,
    codexServiceTier: route.codexServiceTier,
  };
}

function label(route: AdmittedRoute, identity: PiRuntimeIdentity): string {
  return [
    route.selectedModel,
    route.modelProviderType,
    route.runtimeProviderType,
    `${identity.provider}:${identity.model}`,
  ].join(" | ");
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

/**
 * Routes admitted by catalog eligibility and route rules, enumerated before the
 * capability gate. Enumerating after it would let a dropped capability entry
 * remove its own route from the comparison instead of failing this test.
 */
function admittedRoutes(): readonly AdmittedRoute[] {
  const routes: AdmittedRoute[] = [];
  for (const selectedModel of SEEDED_ROUTED_MODELS) {
    const providers = new Set<string>([
      "built-in",
      "codex-oauth-token",
      "claude-code-oauth-token",
    ]);
    for (const modelProviderType of providers) {
      const runtimes =
        modelProviderType === "built-in"
          ? ["built-in", ...seededBuiltInProviderTypes(selectedModel)]
          : [modelProviderType];
      for (const runtimeProviderType of runtimes) {
        for (const codexServiceTier of [undefined, "fast"] as const) {
          const route = {
            selectedModel,
            modelProviderType,
            runtimeProviderType,
            codexServiceTier,
          };
          if (isPiAdmittedRoute(routeArgs(route))) {
            routes.push(route);
          }
        }
      }
    }
  }
  return routes;
}

describe("pinned Pi runtime capability", () => {
  it("resolves every identity the capability data declares", () => {
    const unresolved = declaredIdentities()
      .filter((identity) => {
        return !resolvesInRuntime(identity);
      })
      .map((identity) => {
        return `${identity.provider}:${identity.model}`;
      });
    expect(unresolved).toStrictEqual([]);
  });

  it("agrees with the resolver on every admitted model and route", () => {
    const routes = admittedRoutes();
    expect(routes.length).toBeGreaterThan(0);
    const disagreements: string[] = [];
    for (const route of routes) {
      const identities = piRouteCatalogIdentities(routeArgs(route));
      for (const identity of identities) {
        if (!resolvesInRuntime(identity)) {
          disagreements.push(`unresolvable ${label(route, identity)}`);
        }
      }
      const resolvable =
        identities.length > 0 && identities.every(resolvesInRuntime);
      if (resolvable !== isPiRouteRuntimeCapable(routeArgs(route))) {
        disagreements.push(
          `gate disagrees for ${route.selectedModel} | ${route.modelProviderType} | ${route.runtimeProviderType}`,
        );
      }
    }
    expect(disagreements).toStrictEqual([]);
  });

  it.each(["gpt-6-sol", "gpt-6-luna"])(
    "resolves %s through the pinned Pi catalog",
    (model) => {
      const identities: readonly PiRuntimeIdentity[] = [
        { provider: "openai", model },
        { provider: "openai-codex", model },
        { provider: "openrouter", model: `openai/${model}` },
      ];
      for (const identity of identities) {
        expect(resolvesInRuntime(identity)).toBe(true);
      }
      for (const modelProviderType of seededProviderTypes(model)) {
        expect(
          isPiExecutionRoute({
            catalogModel: piCatalogModel(SEEDED_MODEL_CATALOG, model),
            modelProviderType,
            runtimeProviderType: modelProviderType,
            codexServiceTier: undefined,
          }),
        ).toBe(modelProviderType === "codex-oauth-token");
      }
    },
  );
});
