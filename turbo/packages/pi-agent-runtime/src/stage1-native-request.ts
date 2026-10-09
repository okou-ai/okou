import { preparePayload as prepareResponsesPayload } from "@earendil-works/pi-ai/api/openai-responses";
import { preparePayload as prepareCompletionsPayload } from "@earendil-works/pi-ai/api/openai-completions";
import { preparePayload as prepareCodexPayload } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import {
  clampThinkingLevel,
  normalizeContext,
  type Context,
} from "@earendil-works/pi-ai";
import {
  PI_MEMORY_PRESET,
  PI_MEMORY_STAGE1_REASONING,
  memoryPresetPayload,
} from "./memory-background-config";
import { resolvePiAgentModel } from "./model";
import {
  PI_MEMORY_STAGE1_SYSTEM_PROMPT,
  renderPiMemoryStage1Input,
} from "./stage1-prompts";
import type { PiAgentModelConfig } from "./types";
import type { PiAgentStreamOptions } from "./stream-options";
import {
  isRecord,
  PiMemoryStage1BudgetError,
  PI_MEMORY_STAGE1_OUTPUT_TOKENS,
  selectStage1Evidence,
  serializeStage1Payload,
  stage1InputBudgets,
  stage1TokenCount,
  type PiMemoryStage1Evidence,
} from "./stage1-input";
import {
  PI_MEMORY_STAGE1_RESPONSE_SCHEMA,
  PiMemoryStage1ProviderError,
} from "./stage1-provider";

function stage1PayloadInput(
  normalized: Record<string, unknown>,
  input: readonly unknown[],
  native: boolean,
): Record<string, unknown> {
  const format = {
    type: "json_schema",
    name: "pi_memory_stage1",
    strict: true,
    schema: PI_MEMORY_STAGE1_RESPONSE_SCHEMA,
  };
  if (native) {
    if (
      normalized.instructions !== PI_MEMORY_STAGE1_SYSTEM_PROMPT ||
      normalized.max_output_tokens !== undefined ||
      !isRecord(normalized.text)
    ) {
      throw new PiMemoryStage1BudgetError("input_payload_unmeasurable");
    }
    // pi-ai 0.86.1's native adapter omits samplingParams. Upstream Codex
    // phase1.rs/common.rs supplies strict text.format, but no output-token cap.
    normalized.text.format = format;
  } else {
    const system: unknown = input[0];
    if (
      normalized.max_output_tokens !== PI_MEMORY_STAGE1_OUTPUT_TOKENS ||
      !isRecord(system) ||
      !["system", "developer"].includes(String(system.role)) ||
      system.content !== PI_MEMORY_STAGE1_SYSTEM_PROMPT ||
      !isRecord(normalized.text) ||
      JSON.stringify(normalized.text.format) !== JSON.stringify(format)
    ) {
      throw new PiMemoryStage1BudgetError("input_payload_unmeasurable");
    }
  }
  const user: unknown = input[native ? 0 : 1];
  if (
    !isRecord(user) ||
    user.role !== "user" ||
    !Array.isArray(user.content) ||
    user.content.length !== 1
  ) {
    throw new PiMemoryStage1BudgetError("input_payload_unmeasurable");
  }
  const part: unknown = user.content[0];
  if (
    !isRecord(part) ||
    part.type !== "input_text" ||
    part.text !== renderPiMemoryStage1Input("")
  ) {
    throw new PiMemoryStage1BudgetError("input_payload_unmeasurable");
  }
  return part;
}

const PI_MEMORY_STAGE1_CHAT_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "pi_memory_stage1",
    strict: true,
    schema: PI_MEMORY_STAGE1_RESPONSE_SCHEMA,
  },
};

/** Return the single text part, normalizing string content to one part. */
function singleChatTextPart(
  message: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (typeof message.content === "string") {
    const part = { type: "text", text: message.content };
    message.content = [part];
    return part;
  }
  if (!Array.isArray(message.content) || message.content.length !== 1) {
    return undefined;
  }
  const part: unknown = message.content[0];
  return isRecord(part) && part.type === "text" ? part : undefined;
}

/** Locate the Chat Completions evidence slot; cache breakpoints may wrap text. */
function stage1ChatPayloadInput(
  normalized: Record<string, unknown>,
): Record<string, unknown> {
  const messages = normalized.messages;
  if (
    !Array.isArray(messages) ||
    messages.length !== 2 ||
    (normalized.model !== PI_MEMORY_PRESET &&
      (normalized.max_tokens !== PI_MEMORY_STAGE1_OUTPUT_TOKENS ||
        normalized.max_completion_tokens !== undefined ||
        JSON.stringify(normalized.response_format) !==
          JSON.stringify(PI_MEMORY_STAGE1_CHAT_RESPONSE_FORMAT)))
  ) {
    throw new PiMemoryStage1BudgetError("input_payload_unmeasurable");
  }
  const [system, user]: unknown[] = messages;
  const systemPart =
    isRecord(system) && ["system", "developer"].includes(String(system.role))
      ? singleChatTextPart(system)
      : undefined;
  const userPart =
    isRecord(user) && user.role === "user"
      ? singleChatTextPart(user)
      : undefined;
  if (
    systemPart?.text !== PI_MEMORY_STAGE1_SYSTEM_PROMPT ||
    userPart?.text !== renderPiMemoryStage1Input("")
  ) {
    throw new PiMemoryStage1BudgetError("input_payload_unmeasurable");
  }
  return userPart;
}

function shapePiMemoryStage1NativePayload(
  payload: unknown,
  evidence: readonly PiMemoryStage1Evidence[],
  model: NonNullable<ReturnType<typeof resolvePiAgentModel>>,
): unknown {
  // Normalize once so the exact object returned to the SDK is plain JSON.
  const normalized: unknown = JSON.parse(
    serializeStage1Payload(
      model.id === PI_MEMORY_PRESET ? memoryPresetPayload(payload) : payload,
    ),
  );
  const native = model.api === "openai-codex-responses";
  if (
    !isRecord(normalized) ||
    normalized.tools !== undefined ||
    normalized.model !== model.id ||
    normalized.service_tier !== undefined
  )
    throw new PiMemoryStage1BudgetError("input_payload_unmeasurable");
  let part: Record<string, unknown>;
  if (model.api === "openai-completions") {
    part = stage1ChatPayloadInput(normalized);
  } else {
    if (
      !Array.isArray(normalized.input) ||
      normalized.input.length !== (native ? 1 : 2)
    )
      throw new PiMemoryStage1BudgetError("input_payload_unmeasurable");
    part = stage1PayloadInput(normalized, normalized.input, native);
  }
  const budget = stage1InputBudgets(
    model.contextWindow,
    native ? { maxTokens: model.maxTokens } : undefined,
  );
  const overhead = stage1TokenCount(serializeStage1Payload(normalized));
  let allowance = budget.request - overhead - 32;
  let historyAllowance = budget.history;
  if (allowance <= 0)
    throw new PiMemoryStage1BudgetError("input_budget_exceeded");
  if (
    model.id !== PI_MEMORY_PRESET &&
    (!isRecord(normalized.reasoning) ||
      normalized.reasoning.effort !== PI_MEMORY_STAGE1_REASONING)
  ) {
    throw new PiMemoryStage1BudgetError("input_payload_unmeasurable");
  }
  // Boundary merges in BPE can change additive row counts. Re-select by tier
  // with a smaller budget; never apply a whole-history head/tail truncation.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const history = selectStage1Evidence(evidence, historyAllowance, allowance);
    part.text = renderPiMemoryStage1Input(history);
    const serialized = serializeStage1Payload(normalized);
    const tokens = stage1TokenCount(serialized);
    const historyTokens = stage1TokenCount(history);
    if (tokens <= budget.request && historyTokens <= budget.history)
      return normalized;
    allowance -= Math.max(128, tokens - budget.request);
    historyAllowance -= Math.max(128, historyTokens - budget.history);
  }
  throw new PiMemoryStage1BudgetError("input_budget_exceeded");
}

/** Pure SDK inputs; admission and provider execution stay with their owners. */
export function preparePiMemoryStage1NativeRequest(config: PiAgentModelConfig) {
  const model = resolvePiAgentModel(config);
  if (
    !model ||
    (model.api !== "openai-responses" &&
      model.api !== "openai-completions" &&
      model.api !== "openai-codex-responses") ||
    config.serviceTier !== undefined ||
    !config.apiKey.trim()
  ) {
    throw new PiMemoryStage1ProviderError();
  }
  if (config.dialect === "openai-codex-responses" && !config.accountId.trim()) {
    // Preserve the stream adapter's rejection before admission can execute.
    throw new Error("Pi Codex Responses requires an explicit account ID");
  }
  const context = normalizeContext({
    systemPrompt: PI_MEMORY_STAGE1_SYSTEM_PROMPT,
    messages: [
      { role: "user", content: renderPiMemoryStage1Input(""), timestamp: 0 },
    ],
    tools: [],
  } satisfies Context);
  return {
    model,
    context,
    options: {
      apiKey: config.apiKey,
      reasoning:
        model.id === PI_MEMORY_PRESET ? undefined : PI_MEMORY_STAGE1_REASONING,
      samplingParams:
        model.id === PI_MEMORY_PRESET
          ? undefined
          : model.api === "openai-completions"
            ? {
                // Override the SDK's catalog-ceiling default with the fixed cap.
                max_completion_tokens: undefined,
                max_tokens: PI_MEMORY_STAGE1_OUTPUT_TOKENS,
                response_format: PI_MEMORY_STAGE1_CHAT_RESPONSE_FORMAT,
              }
            : {
                max_output_tokens: PI_MEMORY_STAGE1_OUTPUT_TOKENS,
                text: {
                  format: {
                    type: "json_schema",
                    name: "pi_memory_stage1",
                    strict: true,
                    schema: PI_MEMORY_STAGE1_RESPONSE_SCHEMA,
                  },
                },
              },
    } satisfies PiAgentStreamOptions,
  };
}

/** Measure the pinned SDK's complete request body before API-owned admission. */
export function preparePiMemoryStage1NativePayload(args: {
  readonly model: PiAgentModelConfig;
  readonly evidence: readonly PiMemoryStage1Evidence[];
  readonly requestId: string;
}): unknown {
  const plan = preparePiMemoryStage1NativeRequest(args.model);
  const base = buildBaseOptions(
    plan.model,
    plan.context,
    {
      ...plan.options,
      sessionId:
        args.model.dialect === "openai-completions"
          ? (args.model.sessionAffinityKey ?? args.requestId)
          : args.requestId,
    },
    args.model.apiKey,
  );
  const reasoning =
    plan.options.reasoning === undefined
      ? undefined
      : clampThinkingLevel(plan.model, plan.options.reasoning);
  const options = {
    ...base,
    reasoningEffort: reasoning === "off" ? undefined : reasoning,
  };
  let payload: unknown;
  try {
    switch (plan.model.api) {
      case "openai-responses": {
        payload = prepareResponsesPayload(plan.model, plan.context, options);
        break;
      }
      case "openai-completions": {
        payload = prepareCompletionsPayload(plan.model, plan.context, options);
        break;
      }
      case "openai-codex-responses": {
        payload = prepareCodexPayload(plan.model, plan.context, options);
        break;
      }
    }
  } catch {
    // The SDK folds request-construction failures into usage-free terminal errors.
    throw new PiMemoryStage1ProviderError();
  }
  try {
    return shapePiMemoryStage1NativePayload(payload, args.evidence, plan.model);
  } catch (error) {
    throw error instanceof PiMemoryStage1BudgetError
      ? error
      : new PiMemoryStage1BudgetError("input_payload_unmeasurable");
  }
}
