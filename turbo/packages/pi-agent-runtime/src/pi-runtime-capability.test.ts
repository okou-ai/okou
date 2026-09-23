import { describe, expect, it } from "vitest";
import {
  ACTIVE_RUN_MODELS,
  getBuiltInModelRouteCandidates,
  getProvidersForModel,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  isPiExecutionRoute,
  isPiPolicyAdmittedRoute,
  isPiRouteRuntimeCapable,
  piRouteCatalogIdentities,
} from "@okouai/core/pi-execution";
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
  if (identity.provider === "anthropic") {
    return (
      resolvePiAgentModel({
        dialect: "anthropic-messages",
        transport: "sse",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        apiKey: "capability-probe",
        model: identity.model,
        catalogModel: identity.model,
        requestHeaders: {},
      }) !== null
    );
  }
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

function label(route: AdmittedRoute, identity: PiRuntimeIdentity): string {
  return [
    route.selectedModel,
    route.modelProviderType,
    route.runtimeProviderType,
    `${identity.provider}:${identity.model}`,
  ].join(" | ");
}

/**
 * Routes admitted by model policy and route rules, enumerated before the
 * capability gate. Enumerating after it would let a dropped capability entry
 * remove its own route from the comparison instead of failing this test.
 */
function policyAdmittedRoutes(): readonly AdmittedRoute[] {
  const routes: AdmittedRoute[] = [];
  for (const selectedModel of ACTIVE_RUN_MODELS) {
    const providers = new Set<string>([
      ...getProvidersForModel(selectedModel),
      "custom-anthropic-messages",
      "custom-openai-responses",
    ]);
    for (const modelProviderType of providers) {
      const runtimes =
        modelProviderType === "built-in"
          ? [
              "built-in",
              ...getBuiltInModelRouteCandidates(selectedModel).map(
                (candidate) => {
                  return candidate.providerType;
                },
              ),
            ]
          : [modelProviderType];
      for (const runtimeProviderType of runtimes) {
        for (const codexServiceTier of [undefined, "fast"] as const) {
          const route = {
            selectedModel,
            modelProviderType,
            runtimeProviderType,
            codexServiceTier,
          };
          if (isPiPolicyAdmittedRoute(route)) {
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
    const routes = policyAdmittedRoutes();
    expect(routes.length).toBeGreaterThan(0);
    const disagreements: string[] = [];
    for (const route of routes) {
      const identities = piRouteCatalogIdentities(route);
      for (const identity of identities) {
        if (!resolvesInRuntime(identity)) {
          disagreements.push(`unresolvable ${label(route, identity)}`);
        }
      }
      const resolvable =
        identities.length > 0 && identities.every(resolvesInRuntime);
      if (resolvable !== isPiRouteRuntimeCapable(route)) {
        disagreements.push(
          `gate disagrees for ${route.selectedModel} | ${route.modelProviderType} | ${route.runtimeProviderType}`,
        );
      }
    }
    expect(disagreements).toStrictEqual([]);
  });

  it("leaves Claude Opus 5.5 off the loop while the native catalog lacks it", () => {
    expect(
      resolvesInRuntime({ provider: "anthropic", model: "claude-opus-5-5" }),
    ).toBe(false);
    for (const modelProviderType of getProvidersForModel("claude-opus-5-5")) {
      expect(
        isPiExecutionRoute({
          selectedModel: "claude-opus-5-5",
          modelProviderType,
          runtimeProviderType: modelProviderType,
          codexServiceTier: undefined,
          piEnabled: true,
        }),
      ).toBe(false);
    }
  });

  it("leaves a pre-launch model the pinned catalog lacks off the loop", () => {
    // `gpt-6-sol` is absent from every pinned catalog. These are the identities
    // its Built-in and BYOK routes would request if it were ever admitted, so
    // admission has to refuse it before session creation can throw.
    const identities: readonly PiRuntimeIdentity[] = [
      { provider: "openai", model: "gpt-6-sol" },
      { provider: "openai-codex", model: "gpt-6-sol" },
      { provider: "openrouter", model: "openai/gpt-6-sol" },
    ];
    for (const identity of identities) {
      expect(resolvesInRuntime(identity)).toBe(false);
    }
    for (const modelProviderType of getProvidersForModel("gpt-6-sol")) {
      expect(
        isPiExecutionRoute({
          selectedModel: "gpt-6-sol",
          modelProviderType,
          runtimeProviderType: modelProviderType,
          codexServiceTier: undefined,
          piEnabled: true,
        }),
      ).toBe(false);
    }
  });
});
