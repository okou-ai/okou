import {
  AUTO_RUN_MODEL,
  isAutoSelectedModel,
  isAutoRunPreset,
} from "@okouai/core/auto-run-model";
import {
  isOkouRunModel,
  type OkouRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import { OKOU_MODEL_METADATA } from "@okouai/api-contracts/contracts/okou-model-metadata";
import { stream as streamCodexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { streamSimple as streamSimpleCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import {
  stream as streamResponses,
  streamSimple as streamSimpleResponses,
} from "@earendil-works/pi-ai/api/openai-responses";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type {
  Api,
  AssistantMessageEventStream,
  TranscriptContext,
  Model,
} from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";

import type { PiAgentModelConfig, PiAgentStreamConfig } from "./types";
import { piModelLimitOverride } from "./model-limits";
import { streamWithModelRequestDiagnostics } from "./model-request-diagnostics";
import {
  observePiResponseStatus,
  type PiAgentStreamOptions,
} from "./stream-options";

const PI_AGENT_USER_AGENT = "okou-pi-agent/1.0";

const OKOU_PI_MODEL_COSTS = {
  "okou-1.0": {
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
  },
} as const satisfies Record<
  OkouRunModel,
  {
    readonly cost: Model<Api>["cost"];
  }
>;

/** Product-owned Pi catalog entries for the independently named Okou models. */
function okouSourceModel(
  provider: string,
  model: string,
): Model<Api> | undefined {
  if (provider !== "openrouter" || !isOkouRunModel(model)) {
    return undefined;
  }
  const metadata = OKOU_MODEL_METADATA[model];
  const pricing = OKOU_PI_MODEL_COSTS[model];
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
    cost: pricing.cost,
  };
}

function providerModels(provider: string): readonly Model<Api>[] {
  switch (provider) {
    case "openai-codex": {
      return openaiCodexProvider().getModels();
    }
    case "openrouter": {
      return openrouterProvider().getModels();
    }
    default: {
      return [];
    }
  }
}

function isResponsesModel(
  model: Model<Api>,
): model is Model<"openai-responses"> {
  return model.api === "openai-responses";
}

function isCompletionsModel(
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

function isCodexResponsesModel(
  model: Model<Api>,
): model is Model<"openai-codex-responses"> {
  return model.api === "openai-codex-responses";
}

function catalogSourceModel(
  provider: string,
  model: string,
): Model<Api> | undefined {
  const okouModel = okouSourceModel(provider, model);
  if (okouModel) {
    return okouModel;
  }
  // The pinned Pi catalog predates 6.1 Sol. Only the ChatGPT subscription is
  // approved; do not infer OpenRouter support.
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
  // pi-ai 0.85.1 predates V4.1. This exact identity uses the provider
  // metadata recorded in deepseek-v41-catalog.md, never the V4 text-only model.
  if (provider === "openrouter" && model === "deepseek/deepseek-v4.1-flash") {
    return {
      id: model,
      name: "DeepSeek V4.1 Flash",
      provider,
      api: "openai-responses",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
      thinkingLevelMap: {
        minimal: null,
        low: "low",
        medium: null,
        high: "high",
        max: "max",
      },
      input: ["text", "image"],
      contextWindow: 1_048_576,
      maxTokens: 384_000,
      cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
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

function streamSimpleResponsesWithPolicy(
  model: Model<"openai-responses">,
  context: TranscriptContext,
  options?: PiAgentStreamOptions,
): AssistantMessageEventStream {
  const serviceTier = options?.serviceTier;
  if (serviceTier !== undefined && serviceTier !== "priority") {
    throw new Error("Pi public Responses service tier only accepts priority");
  }
  const base = buildBaseOptions(model, context, options, options?.apiKey);
  const clampedReasoning =
    options?.reasoning === undefined
      ? undefined
      : clampThinkingLevel(model, options.reasoning);
  return streamResponses(model, context, {
    ...base,
    reasoningEffort: clampedReasoning === "off" ? undefined : clampedReasoning,
    serviceTier,
  });
}

const piAgentStream = (
  model: Model<"openai-responses">,
  context: TranscriptContext,
  options?: PiAgentStreamOptions,
): AssistantMessageEventStream => {
  if (options?.serviceTier === undefined) {
    return streamSimpleResponses(model, context, options);
  }
  return streamSimpleResponsesWithPolicy(model, context, options);
};

function piAgentCodexStream(
  model: Model<"openai-codex-responses">,
  context: TranscriptContext,
  accountId: string,
  options?: PiAgentStreamOptions,
): AssistantMessageEventStream {
  const serviceTier = options?.serviceTier;
  if (serviceTier !== undefined && serviceTier !== "fast") {
    throw new Error("Pi Codex Responses only accepts the fast service tier");
  }
  const base = buildBaseOptions(model, context, options, options?.apiKey);
  const clampedReasoning =
    options?.reasoning === undefined
      ? undefined
      : clampThinkingLevel(model, options.reasoning);
  return streamCodexResponses(model, context, {
    ...base,
    reasoningEffort: clampedReasoning === "off" ? undefined : clampedReasoning,
    // Codex keeps fast in config but sends priority on Responses requests.
    serviceTier: serviceTier === "fast" ? "priority" : undefined,
    accountId,
    // Transport retries stay off here: the Codex adapter replaces a capped
    // Retry-After with a bare delay error, which would discard the friendly
    // usage-limit message the failure classifiers depend on. Recovery for a
    // transient answer belongs to the session retry budget instead.
    maxRetries: 0,
    transport: "sse",
  });
}

/** Type bridge for Pi's API-generic provider registration callback. */
export const piAgentRegisteredStream = (
  model: Model<Api>,
  context: TranscriptContext,
  options?: PiAgentStreamOptions,
): AssistantMessageEventStream => {
  if (isCompletionsModel(model)) {
    return streamSimpleCompletions(model, context, options);
  }
  if (!isResponsesModel(model)) {
    throw new Error(
      `Pi runtime requires openai-responses or openai-completions, got ${model.api}`,
    );
  }
  return piAgentStream(model, context, options);
};

/** Apply API-owned per-request policy to Sandbox and maintenance turns. */
export function piAgentStreamForConfig(
  config: PiAgentStreamConfig,
): typeof piAgentRegisteredStream {
  return (model, context, options) => {
    const configuredOptions = {
      ...options,
      headers: {
        ...options?.headers,
        "User-Agent": PI_AGENT_USER_AGENT,
      },
      // The immutable route owns tier even when standard omits it.
      serviceTier: config.serviceTier,
    };
    const start = (fetch: NonNullable<PiAgentStreamOptions["fetch"]>) => {
      // Observe transport evidence before a body guard can consume or reject it.
      // Every public route still drops markup and bounds opaque upstream errors.
      const responseOptions = {
        ...configuredOptions,
        fetch,
      };
      if (config.dialect === "openai-completions") {
        if (!isCompletionsModel(model)) {
          throw new Error(
            `Pi Chat Completions route received unexpected ${model.api} model`,
          );
        }
        return streamSimpleCompletions(model, context, {
          ...responseOptions,
          ...(config.sessionAffinityKey === undefined
            ? {}
            : { sessionId: config.sessionAffinityKey }),
        });
      }
      if (config.dialect === "openai-responses") {
        if (!isResponsesModel(model)) {
          throw new Error(
            `Pi public Responses route received unexpected ${model.api} model`,
          );
        }
        return piAgentStream(model, context, responseOptions);
      }
      if (!isCodexResponsesModel(model)) {
        throw new Error(
          `Pi Codex Responses route received unexpected ${model.api} model`,
        );
      }
      if (config.transport !== "sse")
        throw new Error("Pi Codex Responses requires SSE transport");
      if (!config.accountId?.trim())
        throw new Error("Pi Codex Responses requires an explicit account ID");
      return piAgentCodexStream(
        model,
        context,
        config.accountId,
        responseOptions,
      );
    };
    const fetch = observePiResponseStatus(
      configuredOptions.fetch ?? globalThis.fetch,
      configuredOptions.onObservedResponseStatus,
    );
    return streamWithModelRequestDiagnostics(
      start,
      fetch,
      configuredOptions.signal,
    );
  };
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
  return autoRuntime ? AUTO_RUN_MODEL : identity;
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
