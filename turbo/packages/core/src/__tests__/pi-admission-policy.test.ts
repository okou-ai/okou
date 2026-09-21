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
  PI_MODEL_POLICY,
  type PiModelPolicyCoversEveryActiveModel,
} from "../pi-execution";
import { PI_RUNTIME_RESOLVABLE_MODELS } from "../pi-runtime-capability";

/**
 * Every active model against every provider in its
 * `MODEL_FIRST_PROVIDER_COMPATIBILITY` row plus both custom gateways, for each
 * runtime route the Built-in vendor picker can land on and both Codex service
 * tiers. `ADMITTED_ON_MAIN` is the decision main @ 3938412 produced for that
 * enumeration; this slice is behaviour-preserving, so it must not move.
 */
const ADMITTED_ON_MAIN = [
  "claude-fable-5-1 | built-in | built-in | standard",
  "claude-fable-5-1 | built-in | built-in | fast",
  "claude-fable-5-1 | built-in | anthropic-api-key | standard",
  "claude-fable-5-1 | built-in | anthropic-api-key | fast",
  "claude-fable-5-1 | built-in | openrouter-api-key | standard",
  "claude-fable-5-1 | built-in | openrouter-api-key | fast",
  "claude-fable-5-1 | anthropic-api-key | anthropic-api-key | standard",
  "claude-fable-5-1 | anthropic-api-key | anthropic-api-key | fast",
  "claude-fable-5-1 | openrouter-api-key | openrouter-api-key | standard",
  "claude-fable-5-1 | openrouter-api-key | openrouter-api-key | fast",
  "claude-fable-5-1 | vercel-ai-gateway | vercel-ai-gateway | standard",
  "claude-fable-5-1 | vercel-ai-gateway | vercel-ai-gateway | fast",
  "claude-fable-5-1 | azure-foundry | azure-foundry | standard",
  "claude-fable-5-1 | azure-foundry | azure-foundry | fast",
  "claude-fable-5-1 | aws-bedrock | aws-bedrock | standard",
  "claude-fable-5-1 | aws-bedrock | aws-bedrock | fast",
  "claude-fable-5-1 | custom-anthropic-messages | custom-anthropic-messages | standard",
  "claude-fable-5-1 | custom-anthropic-messages | custom-anthropic-messages | fast",
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
  "claude-opus-4-8 | built-in | built-in | standard",
  "claude-opus-4-8 | built-in | built-in | fast",
  "claude-opus-4-8 | built-in | anthropic-api-key | standard",
  "claude-opus-4-8 | built-in | anthropic-api-key | fast",
  "claude-opus-4-8 | built-in | openrouter-api-key | standard",
  "claude-opus-4-8 | built-in | openrouter-api-key | fast",
  "claude-opus-4-8 | anthropic-api-key | anthropic-api-key | standard",
  "claude-opus-4-8 | anthropic-api-key | anthropic-api-key | fast",
  "claude-opus-4-8 | openrouter-api-key | openrouter-api-key | standard",
  "claude-opus-4-8 | openrouter-api-key | openrouter-api-key | fast",
  "claude-opus-4-8 | vercel-ai-gateway | vercel-ai-gateway | standard",
  "claude-opus-4-8 | vercel-ai-gateway | vercel-ai-gateway | fast",
  "claude-opus-4-8 | azure-foundry | azure-foundry | standard",
  "claude-opus-4-8 | azure-foundry | azure-foundry | fast",
  "claude-opus-4-8 | aws-bedrock | aws-bedrock | standard",
  "claude-opus-4-8 | aws-bedrock | aws-bedrock | fast",
  "claude-opus-4-8 | custom-anthropic-messages | custom-anthropic-messages | standard",
  "claude-opus-4-8 | custom-anthropic-messages | custom-anthropic-messages | fast",
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
  "claude-sonnet-4-6 | built-in | built-in | standard",
  "claude-sonnet-4-6 | built-in | built-in | fast",
  "claude-sonnet-4-6 | built-in | anthropic-api-key | standard",
  "claude-sonnet-4-6 | built-in | anthropic-api-key | fast",
  "claude-sonnet-4-6 | built-in | openrouter-api-key | standard",
  "claude-sonnet-4-6 | built-in | openrouter-api-key | fast",
  "claude-sonnet-4-6 | anthropic-api-key | anthropic-api-key | standard",
  "claude-sonnet-4-6 | anthropic-api-key | anthropic-api-key | fast",
  "claude-sonnet-4-6 | openrouter-api-key | openrouter-api-key | standard",
  "claude-sonnet-4-6 | openrouter-api-key | openrouter-api-key | fast",
  "claude-sonnet-4-6 | vercel-ai-gateway | vercel-ai-gateway | standard",
  "claude-sonnet-4-6 | vercel-ai-gateway | vercel-ai-gateway | fast",
  "claude-sonnet-4-6 | azure-foundry | azure-foundry | standard",
  "claude-sonnet-4-6 | azure-foundry | azure-foundry | fast",
  "claude-sonnet-4-6 | aws-bedrock | aws-bedrock | standard",
  "claude-sonnet-4-6 | aws-bedrock | aws-bedrock | fast",
  "claude-sonnet-4-6 | custom-anthropic-messages | custom-anthropic-messages | standard",
  "claude-sonnet-4-6 | custom-anthropic-messages | custom-anthropic-messages | fast",
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
  "gpt-5.6-terra | built-in | built-in | standard",
  "gpt-5.6-terra | built-in | openai-api-key | standard",
  "gpt-5.6-terra | built-in | openai-api-key | fast",
  "gpt-5.6-terra | built-in | openrouter-codex | standard",
  "gpt-5.6-terra | built-in | openrouter-codex | fast",
  "gpt-5.6-terra | openai-api-key | openai-api-key | standard",
  "gpt-5.6-terra | openai-api-key | openai-api-key | fast",
  "gpt-5.6-terra | codex-oauth-token | codex-oauth-token | standard",
  "gpt-5.6-terra | codex-oauth-token | codex-oauth-token | fast",
  "gpt-5.6-terra | openrouter-codex | openrouter-codex | standard",
  "gpt-5.6-terra | openrouter-codex | openrouter-codex | fast",
  "gpt-5.6-terra | vercel-ai-gateway-codex | vercel-ai-gateway-codex | standard",
  "gpt-5.6-terra | vercel-ai-gateway-codex | vercel-ai-gateway-codex | fast",
  "gpt-5.6-terra | custom-openai-responses | custom-openai-responses | standard",
  "gpt-5.6-terra | custom-openai-responses | custom-openai-responses | fast",
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
  "deepseek-v4-pro | built-in | deepseek | standard",
  "deepseek-v4-pro | built-in | deepseek | fast",
  "deepseek-v4-pro | built-in | openrouter-codex | standard",
  "deepseek-v4-pro | built-in | openrouter-codex | fast",
  "deepseek-v4-pro | deepseek | deepseek | standard",
  "deepseek-v4-pro | deepseek | deepseek | fast",
  "deepseek-v4-pro | openrouter-codex | openrouter-codex | standard",
  "deepseek-v4-pro | openrouter-codex | openrouter-codex | fast",
  "deepseek-v4-pro | custom-openai-responses | custom-openai-responses | standard",
  "deepseek-v4-pro | custom-openai-responses | custom-openai-responses | fast",
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

const ENUMERATED_COMBINATIONS = 236;

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

function enumerateCombinations(): readonly Combination[] {
  const combinations: Combination[] = [];
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

describe("Pi admission policy table", () => {
  it("records a decision for exactly the active run models", () => {
    expect(Object.keys(PI_MODEL_POLICY).sort()).toStrictEqual(
      [...ACTIVE_RUN_MODELS].sort(),
    );
    // The type alias fails `tsc` when the table and `ActiveRunModel` diverge,
    // so a new `SUPPORTED_RUN_MODELS` entry cannot compile without a decision.
    const coversEveryActiveModel: PiModelPolicyCoversEveryActiveModel = true;
    expect(coversEveryActiveModel).toBe(true);
  });

  it("explains every model kept off the Pi loop", () => {
    const excluded = Object.entries(PI_MODEL_POLICY).filter(([, policy]) => {
      return !policy.pi;
    });
    expect(
      excluded.map(([model]) => {
        return model;
      }),
    ).toStrictEqual(["gpt-6-astra", "gpt-6-sol"]);
    for (const [model, policy] of excluded) {
      expect(policy.pi, model).toBe(false);
      if (!policy.pi) {
        expect(policy.exception.length, model).toBeGreaterThan(0);
        expect(policy.reason.length, model).toBeGreaterThan(0);
      }
    }
  });
});

describe("Pi admission decisions", () => {
  it("keeps the decision of main @ 3938412 for every model and route", () => {
    const combinations = enumerateCombinations();
    expect(combinations).toHaveLength(ENUMERATED_COMBINATIONS);
    const admitted = combinations
      .filter((combination) => {
        return isPiExecutionRoute({ ...combination, piEnabled: true });
      })
      .map(label);
    expect(admitted).toStrictEqual([...ADMITTED_ON_MAIN]);
  });

  it("admits nothing while the Pi loop switch is off", () => {
    for (const combination of enumerateCombinations()) {
      expect(isPiExecutionRoute({ ...combination, piEnabled: false })).toBe(
        false,
      );
    }
  });

  it("still routes claude-fable-5-1 to Pi", () => {
    expect(
      isPiExecutionRoute({
        selectedModel: "claude-fable-5-1",
        modelProviderType: "built-in",
        runtimeProviderType: "anthropic-api-key",
        codexServiceTier: undefined,
        piEnabled: true,
      }),
    ).toBe(true);
  });

  it("keeps a model the pinned runtime cannot resolve out of the loop", () => {
    expect(
      isPiRouteRuntimeCapable({
        selectedModel: "gpt-6-sol",
        modelProviderType: "openai-api-key",
        runtimeProviderType: "openai-api-key",
      }),
    ).toBe(false);
    expect(
      isPiExecutionRoute({
        selectedModel: "gpt-6-sol",
        modelProviderType: "openai-api-key",
        runtimeProviderType: "openai-api-key",
        codexServiceTier: undefined,
        piEnabled: true,
      }),
    ).toBe(false);
  });
});

describe("Pi runtime capability data", () => {
  it("carries exactly the identities admitted routes can request", () => {
    const requested = new Set<string>();
    for (const combination of enumerateCombinations()) {
      // Enumerated before the capability gate, so a missing entry cannot hide
      // by removing its own route from the comparison.
      if (!isPiPolicyAdmittedRoute(combination)) {
        continue;
      }
      for (const identity of piRouteCatalogIdentities(combination)) {
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
    expect([...requested].sort()).toStrictEqual([...declared].sort());
  });
});
