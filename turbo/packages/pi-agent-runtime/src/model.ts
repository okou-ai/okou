import { piNativeCatalogModelSchema } from "@okouai/api-contracts/contracts/pi-native-models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { streamPiNative } from "./native-stream";
import { stream as streamCodexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses";
import {
  stream as streamResponses,
  streamSimple as streamSimpleResponses,
} from "@earendil-works/pi-ai/api/openai-responses";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
} from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";

import type { PiAgentModelConfig, PiAgentStreamConfig } from "./types";
import { preserveProviderErrorStatus } from "./provider-error-body";
import {
  observePiResponseStatus,
  type PiAgentStreamOptions,
} from "./stream-options";
import { guardPiUpstreamErrorBody } from "./upstream-error-body";

const PI_AGENT_USER_AGENT = "okou-pi-agent/1.0";

function providerModels(provider: string): readonly Model<Api>[] {
  switch (provider) {
    case "anthropic":
    case "amazon-bedrock": {
      return anthropicProvider().getModels();
    }
    case "deepseek": {
      return deepseekProvider().getModels();
    }
    case "openai": {
      return openaiProvider().getModels();
    }
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

function isMessagesModel(
  model: Model<Api>,
): model is Model<"anthropic-messages"> {
  return model.api === "anthropic-messages";
}

function isResponsesModel(
  model: Model<Api>,
): model is Model<"openai-responses"> {
  return model.api === "openai-responses";
}

function isCodexResponsesModel(
  model: Model<Api>,
): model is Model<"openai-codex-responses"> {
  return model.api === "openai-codex-responses";
}

function sourceModel(provider: string, model: string): Model<Api> | undefined {
  return providerModels(provider).find((candidate) => {
    return candidate.id === model;
  });
}

function streamSimpleResponsesWithPolicy(
  model: Model<"openai-responses">,
  context: Context,
  options?: PiAgentStreamOptions,
): AssistantMessageEventStream {
  const serviceTier = options?.serviceTier;
  if (serviceTier !== undefined && serviceTier !== "priority") {
    throw new Error(
      "Pi public Responses only accepts the priority service tier",
    );
  }
  const base = buildBaseOptions(model, context, options, options?.apiKey);
  const clampedReasoning =
    options?.reasoning === undefined
      ? undefined
      : clampThinkingLevel(model, options.reasoning);
  return streamResponses(model, context, {
    ...base,
    fetch:
      options?.onObservedServiceTier === undefined
        ? base.fetch
        : observeResponsesServiceTier(
            base.fetch ?? globalThis.fetch,
            options.onObservedServiceTier,
          ),
    reasoningEffort: clampedReasoning === "off" ? undefined : clampedReasoning,
    serviceTier,
  });
}

function eventData(frame: string): string | null {
  const data = frame
    .split(/\r?\n/u)
    .filter((line) => {
      return line === "data" || line.startsWith("data:");
    })
    .map((line) => {
      return line.startsWith("data:") ? line.slice(5).replace(/^ /u, "") : "";
    });
  return data.length === 0 ? null : data.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function terminalResponsesServiceTier(frame: string): {
  readonly terminal: boolean;
  readonly serviceTier: string | null | undefined;
} {
  const data = eventData(frame);
  if (data === null || data === "[DONE]") {
    return { terminal: false, serviceTier: undefined };
  }
  try {
    const event = JSON.parse(data) as unknown;
    if (
      !isRecord(event) ||
      (event.type !== "response.completed" &&
        event.type !== "response.incomplete")
    ) {
      return { terminal: false, serviceTier: undefined };
    }
    const response = event.response;
    if (!isRecord(response)) {
      return { terminal: true, serviceTier: undefined };
    }
    const serviceTier = response.service_tier;
    return {
      terminal: true,
      serviceTier:
        typeof serviceTier === "string" || serviceTier === null
          ? serviceTier
          : undefined,
    };
  } catch {
    // Preserve malformed provider bytes for Pi's canonical stream parser. A
    // missing observation remains standard at the billing boundary.
    return { terminal: false, serviceTier: undefined };
  }
}

function observeResponsesServiceTier(
  providerFetch: typeof globalThis.fetch,
  onObservedServiceTier: NonNullable<
    PiAgentStreamOptions["onObservedServiceTier"]
  >,
): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await providerFetch(input, init);
    if (response.body === null) {
      return response;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    let observed = false;
    const inspectFrame = (frame: string): void => {
      if (observed) {
        return;
      }
      const terminal = terminalResponsesServiceTier(frame);
      if (terminal.terminal) {
        observed = true;
        onObservedServiceTier(terminal.serviceTier);
      }
    };
    const inspectCompleteFrames = (): void => {
      while (true) {
        const boundary = /\r?\n\r?\n/u.exec(buffer);
        if (!boundary || boundary.index === undefined) {
          return;
        }
        inspectFrame(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
      }
    };
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          buffer += decoder.decode(chunk, { stream: true });
          inspectCompleteFrames();
          controller.enqueue(chunk);
        },
        flush() {
          buffer += decoder.decode();
          inspectCompleteFrames();
          if (buffer.length > 0) {
            inspectFrame(buffer);
          }
        },
      }),
    );
    return new Response(body, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  };
}

const piAgentStream = (
  model: Model<"openai-responses">,
  context: Context,
  options?: PiAgentStreamOptions,
): AssistantMessageEventStream => {
  if (
    options?.serviceTier === undefined &&
    options?.onObservedServiceTier === undefined
  ) {
    return streamSimpleResponses(model, context, options);
  }
  return streamSimpleResponsesWithPolicy(model, context, options);
};

function piAgentCodexStream(
  model: Model<"openai-codex-responses">,
  context: Context,
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
    fetch:
      options?.onObservedServiceTier === undefined
        ? base.fetch
        : observeResponsesServiceTier(
            base.fetch ?? globalThis.fetch,
            options.onObservedServiceTier,
          ),
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
  context: Context,
  options?: PiAgentStreamOptions,
): AssistantMessageEventStream => {
  if (!isResponsesModel(model)) {
    throw new Error(`Pi runtime requires openai-responses, got ${model.api}`);
  }
  return piAgentStream(model, context, options);
};

/** Apply API-owned per-request policy to both API-first and Sandbox turns. */
export function piAgentStreamForConfig(
  config: PiAgentStreamConfig,
): typeof piAgentRegisteredStream {
  return (model, context, options) => {
    const configuredHeaderNames = new Set(
      Object.keys(config.requestHeaders ?? {}).map((name) => {
        return name.toLowerCase();
      }),
    );
    const inheritedHeaders = Object.fromEntries(
      Object.entries(options?.headers ?? {}).filter(([name]) => {
        return !configuredHeaderNames.has(name.toLowerCase());
      }),
    );
    const configuredOptions = {
      ...options,
      headers: {
        ...inheritedHeaders,
        "User-Agent": PI_AGENT_USER_AGENT,
        ...config.requestHeaders,
      },
      // The immutable route owns tier even when standard omits it.
      serviceTier: config.serviceTier,
    };
    if (
      config.dialect === "anthropic-messages" ||
      config.dialect === "bedrock-converse-stream"
    ) {
      return streamPiNative(config, model, context, configuredOptions);
    }
    // Every public route drops an upstream markup error page before the
    // adapter can fold it into its terminal message. Other opaque gateway
    // bodies then retain their observed status in the terminal error.
    const boundaryFetch = preserveProviderErrorStatus(
      guardPiUpstreamErrorBody(configuredOptions.fetch ?? globalThis.fetch),
    );
    const responseOptions = {
      ...configuredOptions,
      fetch: configuredOptions.onObservedResponseStatus
        ? observePiResponseStatus(
            boundaryFetch,
            configuredOptions.onObservedResponseStatus,
          )
        : boundaryFetch,
    };
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
    if (config.transport !== "sse") {
      throw new Error("Pi Codex Responses requires SSE transport");
    }
    if (!config.accountId?.trim()) {
      throw new Error("Pi Codex Responses requires an explicit account ID");
    }
    return piAgentCodexStream(
      model,
      context,
      config.accountId,
      responseOptions,
    );
  };
}

function resolveNativeModel(
  config: PiAgentModelConfig,
): Model<"anthropic-messages"> | Model<"bedrock-converse-stream"> | null {
  if (
    config.serviceTier !== undefined ||
    !piNativeCatalogModelSchema.safeParse(config.catalogModel).success ||
    !config.catalogModel ||
    config.provider !==
      (config.dialect === "anthropic-messages" ? "anthropic" : "amazon-bedrock")
  )
    return null;
  const native = sourceModel("anthropic", config.catalogModel);
  if (!native || !isMessagesModel(native)) return null;
  const common = {
    ...native,
    id: config.model,
    provider: config.provider,
    baseUrl: config.baseUrl,
  };
  return config.dialect === "anthropic-messages"
    ? { ...common, api: "anthropic-messages" }
    : {
        ...common,
        api: "bedrock-converse-stream",
        compat: {
          supportsStrictMode: native.compat?.supportsStrictTools,
        },
      };
}

/** Resolve model metadata from Pi's native provider catalog. */
export function resolvePiAgentModel(
  config: PiAgentModelConfig,
):
  | Model<"openai-responses">
  | Model<"openai-codex-responses">
  | Model<"anthropic-messages">
  | Model<"bedrock-converse-stream">
  | null {
  if (
    config.serviceTier !== undefined &&
    config.serviceTier !==
      (config.dialect === "openai-codex-responses" ? "fast" : "priority")
  ) {
    return null;
  }
  if (
    config.dialect === "anthropic-messages" ||
    config.dialect === "bedrock-converse-stream"
  ) {
    return resolveNativeModel(config);
  }
  const source = sourceModel(
    config.provider,
    config.catalogModel ?? config.model,
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
    // Pi's catalog API tag controls only whether its API-specific compatibility
    // metadata is safe to reuse. It never selects Okou's runtime transport.
    ...(source.api === dialect && source.compat !== undefined
      ? { compat: source.compat }
      : {}),
  };
  return dialect === "openai-codex-responses"
    ? { ...base, api: "openai-codex-responses" }
    : { ...base, api: "openai-responses" };
}

export function isPiAgentModelSupported(config: PiAgentModelConfig): boolean {
  return resolvePiAgentModel(config) !== null;
}
