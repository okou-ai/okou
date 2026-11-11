import type {
  Api,
  AssistantMessageEventStream,
  Model,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { stream as streamCodexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { streamSimple as streamSimpleCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import {
  stream as streamResponses,
  streamSimple as streamSimpleResponses,
} from "@earendil-works/pi-ai/api/openai-responses";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import {
  isCodexResponsesModel,
  isCompletionsModel,
  isResponsesModel,
} from "./model-catalog";
import { streamWithModelRequestDiagnostics } from "./model-request-diagnostics";
import {
  observePiResponseStatus,
  type PiAgentStreamOptions,
} from "./stream-options";
import type { PiAgentStreamConfig } from "./types";

const PI_AGENT_USER_AGENT = "okou-pi-agent/1.0";

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

/** Apply API-owned per-request policy to Sandbox turns. */
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
