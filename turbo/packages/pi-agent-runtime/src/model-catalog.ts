import type { Api, Model } from "@earendil-works/pi-ai";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { OPENROUTER_MODELS } from "@earendil-works/pi-ai/providers/openrouter.models";
import { isOkouRunModel } from "@okouai/api-contracts/contracts/model-providers";
import { OKOU_MODEL_METADATA } from "@okouai/api-contracts/contracts/okou-model-metadata";
import {
  AUTO_SELECTED_MODEL,
  isAutoRunPreset,
  isAutoSelectedModel,
} from "@okouai/core/auto-run-model";
import { AUTO_PI_RUNTIME_CAPABILITIES } from "@okouai/core/pi-runtime-capability";
import { piModelLimitOverride } from "./model-limits";
import type { PiAgentModelConfig } from "./types";

const AUTO_PI_DISPLAY_ESTIMATE = {
  cost: {
    input: 0.2,
    output: 1.2,
    cacheRead: 0.02,
    cacheWrite: 0.25,
    tiers: [
      {
        inputTokensAbove: 272_000,
        input: 0.4,
        output: 1.8,
        cacheRead: 0.04,
        cacheWrite: 0.5,
      },
    ],
  },
} as const satisfies { readonly cost: Model<Api>["cost"] };

/** Product-owned Pi catalog entries for the independently named Okou models. */
function okouSourceModel(
  provider: string,
  model: string,
): Model<Api> | undefined {
  if (provider !== "openrouter" || !isOkouRunModel(model)) {
    return undefined;
  }
  const metadata = OKOU_MODEL_METADATA[model];
  const estimate = AUTO_PI_DISPLAY_ESTIMATE;
  return {
    id: model,
    name: metadata.displayName,
    provider,
    // The source API tag only guards reuse of API-specific compatibility; the
    // captured route dialect selects the transport.
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    // Reasoning is configured by the OpenRouter Preset, not by the client.
    reasoning: false,
    input: [...metadata.inputModalities],
    contextWindow: metadata.pi.contextWindow,
    maxTokens: metadata.pi.maxTokens,
    cost: estimate.cost,
  };
}

function providerModels(provider: string): readonly Model<Api>[] {
  switch (provider) {
    case "openai-codex": {
      return Object.values(OPENAI_CODEX_MODELS);
    }
    case "openrouter": {
      return Object.values(OPENROUTER_MODELS);
    }
    default: {
      return [];
    }
  }
}

export function isResponsesModel(
  model: Model<Api>,
): model is Model<"openai-responses"> {
  return model.api === "openai-responses";
}

export function isCompletionsModel(
  model: Model<Api>,
): model is Model<"openai-completions"> {
  return model.api === "openai-completions";
}

/**
 * OpenRouter request policy for Chat Completions. Preset model IDs defeat Pi's
 * ID-based detection, so the OpenRouter reasoning shape, Anthropic-style cache
 * breakpoints and session-affinity header are explicit. OpenRouter translates
 * the breakpoints for other upstreams.
 */
const OPENROUTER_COMPLETIONS_COMPAT = {
  thinkingFormat: "openrouter",
  cacheControlFormat: "anthropic",
  sendSessionAffinityHeaders: true,
  sessionAffinityFormat: "openrouter",
} as const satisfies NonNullable<Model<"openai-completions">["compat"]>;

export function isCodexResponsesModel(
  model: Model<Api>,
): model is Model<"openai-codex-responses"> {
  return model.api === "openai-codex-responses";
}

function catalogSourceModel(
  provider: string,
  model: string,
): Model<Api> | undefined {
  if (provider === "openrouter" && model === AUTO_SELECTED_MODEL) {
    // Presets own routing. Pi owns protocol/context capabilities, not catalog alias metadata.
    // Display estimates are not settlement authority; usage settlement uses the Run capture.
    return {
      id: model,
      name: model === AUTO_SELECTED_MODEL ? "Auto" : "Memory",
      provider,
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      ...AUTO_PI_RUNTIME_CAPABILITIES,
      input: [...AUTO_PI_RUNTIME_CAPABILITIES.input],
      cost:
        model === AUTO_SELECTED_MODEL
          ? AUTO_PI_DISPLAY_ESTIMATE.cost
          : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  }
  const okouModel = okouSourceModel(provider, model);
  if (okouModel) {
    return okouModel;
  }
  // Keep product-owned 6.1 Sol metadata for ChatGPT subscriptions independent
  // of upstream catalog updates; do not infer OpenRouter admission.
  if (provider === "openai-codex" && model === "gpt-6.1-sol") {
    const predecessor = providerModels(provider).find((entry) => {
      return entry.id === "gpt-6-sol";
    });
    if (!predecessor) return undefined;
    return {
      ...predecessor,
      id: model,
      name: "GPT 6.1 Sol",
      contextWindow: 1_050_000,
      maxTokens: 128_000,
      cost: {
        input: 2,
        output: 10,
        cacheRead: 0.1,
        cacheWrite: 2.5,
        tiers: [
          {
            inputTokensAbove: 272_000,
            input: 4,
            output: 15,
            cacheRead: 0.2,
            cacheWrite: 5,
          },
        ],
      },
    };
  }
  return providerModels(provider).find((candidate) => {
    return candidate.id === model;
  });
}

function sourceModel(provider: string, model: string): Model<Api> | undefined {
  const source = catalogSourceModel(provider, model);
  if (!source) return undefined;
  const limits = piModelLimitOverride(provider, model);
  return limits ? { ...source, ...limits } : source;
}

function capturedAutoCatalogIdentity(config: PiAgentModelConfig): string {
  const identity = config.catalogModel ?? config.model;
  // Auto's capability class is platform-owned, not a second route.
  // The request still sends the immutable runtime model below.
  const autoRuntime =
    config.provider === "openrouter" &&
    (config.dialect === "openai-responses" ||
      config.dialect === "openai-completions") &&
    isAutoRunPreset(config.model) &&
    (isAutoSelectedModel(identity) || isAutoRunPreset(identity));
  // Retained jobs with legacy/preset-only catalog pins keep their original metadata.
  // Current writers pin canonical Auto explicitly; installed older resolvers also accept it.
  return autoRuntime
    ? identity === AUTO_SELECTED_MODEL
      ? AUTO_SELECTED_MODEL
      : "okou-1.0"
    : identity;
}

/** Resolve model metadata from Pi's provider catalog. */
export function resolvePiAgentModel(
  config: PiAgentModelConfig,
):
  | Model<"openai-responses">
  | Model<"openai-completions">
  | Model<"openai-codex-responses">
  | null {
  if (
    config.serviceTier !== undefined &&
    config.serviceTier !==
      (config.dialect === "openai-codex-responses" ? "fast" : "priority")
  ) {
    return null;
  }
  const source = sourceModel(
    config.provider,
    capturedAutoCatalogIdentity(config),
  );
  if (!source) {
    return null;
  }
  const dialect = config.dialect;
  if (dialect === "openai-responses" && config.provider === "openai-codex") {
    return null;
  }
  if (dialect === "openai-codex-responses" && !isCodexResponsesModel(source)) {
    return null;
  }
  const base = {
    id: config.model,
    name: source.name,
    provider: config.provider,
    baseUrl: config.baseUrl,
    reasoning: source.reasoning,
    thinkingLevelMap: source.thinkingLevelMap,
    input: source.input,
    cost: source.cost,
    contextWindow: source.contextWindow,
    maxTokens: source.maxTokens,
    headers: source.headers,
  };
  if (dialect === "openai-completions") {
    const completionsCompat = isCompletionsModel(source)
      ? source.compat
      : undefined;
    return {
      ...base,
      api: "openai-completions",
      compat: { ...completionsCompat, ...OPENROUTER_COMPLETIONS_COMPAT },
    };
  }
  // Pi's catalog API tag controls only whether its API-specific compatibility
  // metadata is safe to reuse. It never selects Okou's runtime transport.
  const compat =
    source.api === dialect && source.compat !== undefined
      ? source.compat
      : undefined;
  return dialect === "openai-codex-responses"
    ? {
        ...base,
        api: "openai-codex-responses",
        // 0.86's Codex adapter resolves an unset `supportsStrictMode` to true
        // and its catalog never sets the field. Keep strict JSON-schema tools
        // off; enabling them is out of scope for the 0.86.1 upgrade.
        // `supportsMidConvoSystemMessages` from the catalog is deliberately
        // preserved, and asserted on the wire in model.test.ts.
        compat: { ...compat, supportsStrictMode: false },
      }
    : {
        ...base,
        api: "openai-responses",
        ...(compat !== undefined ? { compat } : {}),
      };
}

export function isPiAgentModelSupported(config: PiAgentModelConfig): boolean {
  return resolvePiAgentModel(config) !== null;
}
