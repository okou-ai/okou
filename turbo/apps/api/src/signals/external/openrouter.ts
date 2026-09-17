import { now } from "../../lib/time";
import { optionalEnv } from "../../lib/env";
import {
  onRejection,
  readBoundedResponseText,
  safeJsonParse,
  safeSync,
} from "../utils";
import {
  openRouterFailureReason,
  recordOpenRouterFailure,
  recordOpenRouterFailureTokenCounts,
  recordOpenRouterRequestFailure,
  recordOpenRouterTransportFailure,
  type OpenRouterFailureReason,
  type OpenRouterDiagnostics,
  type OpenRouterTokenCounts,
} from "./openrouter-failure";

const OPENROUTER_CHAT_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_ERROR_RESPONSE_MAX_BYTES = 64 * 1024;

/**
 * The default model for internal fast-path generation: recommended follow-ups,
 * notification summaries, initial thinking copy, and run/activity summaries.
 * Chat and shared-thread titles use a separate, lighter model configured in
 * chat-title.service.ts.
 */
export const FAST_PATH_MODEL = "google/gemini-3.8-flash";

/**
 * Token budget for the short auxiliary text generations (chat and shared-thread
 * titles, notification summaries, run summaries, recommended follow-ups).
 *
 * `FAST_PATH_MODEL` reports `reasoning.mandatory: true` with
 * `supported_efforts: ["high", "medium", "low"]` and no independent reasoning
 * budget, and Gemini 3 spends thinking and visible output from one combined
 * `max_output_tokens`. `effort: "low"` is already the model's floor, so the
 * only remaining lever is the ceiling: a budget sized for the answer alone lets
 * model-chosen thinking starve the answer to nothing. A ceiling is not billed —
 * only generated tokens are — and length stays governed by the prompts, so
 * raising it removes the starvation without buying longer answers.
 */
export const AUXILIARY_TEXT_MAX_TOKENS = 2048;

export interface OpenRouterTextPart {
  readonly type: "text";
  readonly text: string;
}

export interface OpenRouterImagePart {
  readonly type: "image_url";
  readonly image_url: { readonly url: string };
}

export type OpenRouterContentPart = OpenRouterTextPart | OpenRouterImagePart;

interface OpenRouterMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string | readonly OpenRouterContentPart[];
}

export interface OpenRouterTokenDetails {
  readonly cached_tokens?: number;
  readonly cache_write_tokens?: number;
  readonly reasoning_tokens?: number;
}

export interface OpenRouterUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly prompt_tokens_details?: OpenRouterTokenDetails;
  readonly completion_tokens_details?: OpenRouterTokenDetails;
}

interface OpenRouterTextGeneration {
  readonly text: string;
  readonly usage?: OpenRouterUsage;
  /** The completion stopped at the token budget and the text may be partial. */
  readonly truncated?: boolean;
}

interface OpenRouterChoice {
  readonly finish_reason: string | null;
  readonly native_finish_reason?: string | null;
  readonly error?: unknown;
  readonly message?: {
    readonly content?: unknown;
  };
}

interface OpenRouterResponse {
  readonly usage?: OpenRouterUsage;
  readonly error?: unknown;
  readonly choices?: readonly OpenRouterChoice[];
}

type OpenRouterReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";

interface OpenRouterGenerateTextOptions {
  /** Passive observation only; no callbacks, logging, or changes to results. */
  readonly diagnostics?: OpenRouterDiagnostics;
  readonly reasoning?: { readonly effort: OpenRouterReasoningEffort };
  readonly temperature?: number;
  /**
   * Return a non-empty completion that stopped at the token budget instead of
   * throwing. Only callers whose output stays useful when shortened may opt in;
   * anything persisted immutably or parsed as JSON must keep rejecting it.
   */
  readonly acceptTruncatedText?: boolean;
}

export class OpenRouterRequestError extends Error {
  readonly status: number;
  readonly errorType: string | undefined;
  readonly errorCode: string | number | undefined;
  readonly errorParam: string | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(args: {
    readonly message: string;
    readonly status: number;
    readonly errorType?: string;
    readonly errorCode?: string | number;
    readonly errorParam?: string;
    readonly retryAfterMs?: number;
  }) {
    const errorType = args.errorType ? ` (${args.errorType})` : "";
    super(`${args.message}: ${String(args.status)}${errorType}`);
    this.name = "OpenRouterRequestError";
    this.status = args.status;
    this.errorType = args.errorType;
    this.errorCode = args.errorCode;
    this.errorParam = args.errorParam;
    this.retryAfterMs = args.retryAfterMs;
  }
}

function objectProperty(value: unknown, property: string): unknown | undefined {
  if (typeof value !== "object" || value === null || !(property in value)) {
    return undefined;
  }
  return value[property as keyof typeof value];
}

// Provider diagnostics are untrusted data, including strings that look like
// identifiers. Only retain enumerated values; never retain messages or raw data.
function safeDiagnosticString<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  return allowed.find((candidate) => {
    return candidate === value;
  });
}

function safeErrorCode(error: unknown): string | number | undefined {
  const code = objectProperty(error, "code");
  if (
    typeof code === "number" &&
    [400, 401, 402, 403, 404, 408, 413, 422, 429, 500, 502, 503, 504].includes(
      code,
    )
  ) {
    return code;
  }
  return safeDiagnosticString(code, [
    "invalid_request_error",
    "invalid_argument",
    "invalid_parameter",
    "unsupported_parameter",
    "unsupported_value",
    "rate_limit_exceeded",
    "INVALID_ARGUMENT",
    "RESOURCE_EXHAUSTED",
    "UNAVAILABLE",
  ]);
}

function safeErrorParam(error: unknown): string | undefined {
  return safeDiagnosticString(objectProperty(error, "param"), [
    "reasoning",
    "reasoning.effort",
    "reasoning_effort",
    "max_tokens",
    "temperature",
  ]);
}

function openRouterRequestError(args: {
  readonly message: string;
  readonly status: number;
  readonly value: unknown;
  readonly origin: "http" | "completion";
  readonly retryAfterMs?: number;
}): OpenRouterRequestError {
  const error = objectProperty(args.value, "error") ?? args.value;
  const metadata = objectProperty(error, "metadata");
  const errorType = safeDiagnosticString(
    objectProperty(metadata, "error_type"),
    [
      "invalid_image",
      "image_too_small",
      "unsupported_image_format",
      "image_too_large",
      "image_not_found",
      "image_download_failed",
      "invalid_request_error",
    ],
  );
  // OpenRouter may wrap the provider's JSON error in metadata.raw. Parse just
  // one bounded envelope and apply the same allowlists; never attach it as cause.
  const raw = objectProperty(metadata, "raw");
  const provider =
    typeof raw === "string" && Buffer.byteLength(raw, "utf8") <= 4096
      ? objectProperty(safeJsonParse(raw), "error")
      : undefined;
  const errorCode =
    safeDiagnosticString(objectProperty(provider, "status"), [
      "INVALID_ARGUMENT",
      "RESOURCE_EXHAUSTED",
      "UNAVAILABLE",
    ]) ??
    safeErrorCode(provider) ??
    safeErrorCode(error);
  const errorParam = safeErrorParam(provider) ?? safeErrorParam(error);
  const requestError = new OpenRouterRequestError({
    message: args.message,
    status: args.status,
    ...(args.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: args.retryAfterMs }),
    ...(errorType === undefined ? {} : { errorType }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(errorParam === undefined ? {} : { errorParam }),
  });
  recordOpenRouterRequestFailure(
    requestError,
    args.status,
    args.origin,
    args.value,
  );
  return requestError;
}

function retryAfterDelay(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - now();
  return Number.isFinite(delay)
    ? Math.min(300_000, Math.max(0, delay))
    : undefined;
}

async function ensureOpenRouterResponseOk(
  response: Response,
  diagnostics?: OpenRouterDiagnostics,
): Promise<void> {
  if (response.ok) {
    return;
  }
  if (diagnostics) {
    diagnostics.phase = "body_read";
  }
  const errorBody = await readBoundedResponseText(
    response,
    OPENROUTER_ERROR_RESPONSE_MAX_BYTES,
  );
  const errorValue =
    errorBody.kind === "text" ? safeJsonParse(errorBody.text) : undefined;
  if (diagnostics) {
    diagnostics.phase = "status";
  }
  throw openRouterRequestError({
    message: "OpenRouter request failed",
    status: response.status,
    origin: "http",
    value: errorValue,
    retryAfterMs: retryAfterDelay(response.headers.get("retry-after")),
  });
}

/** Provider counts are untrusted numbers; retain only bounded integers. */
export function openRouterTokenCounts(
  usage: OpenRouterUsage | undefined,
): OpenRouterTokenCounts {
  const completionTokens = tokenCount(usage?.completion_tokens);
  const reasoningTokens = tokenCount(
    usage?.completion_tokens_details?.reasoning_tokens,
  );
  return {
    ...(completionTokens === undefined ? {} : { completionTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

function tokenCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(value)))
    : undefined;
}

/**
 * An incomplete completion is a capacity outcome, not invalid provider output.
 * Keeping the distinction finite lets telemetry separate the expected budget
 * ceiling from content the caller genuinely cannot interpret.
 */
function incompleteFinishReason(
  finishReason: string | undefined,
): OpenRouterFailureReason | undefined {
  if (finishReason === "length") {
    return "output_truncated";
  }
  return finishReason === "tool_calls" ? "unexpected_tool_calls" : undefined;
}

function recordOutputDetail(
  diagnostics: OpenRouterDiagnostics | undefined,
  detail: NonNullable<OpenRouterDiagnostics["detail"]>,
): void {
  if (diagnostics) {
    diagnostics.detail = detail;
  }
}

function parseOpenRouterGeneration(
  data: OpenRouterResponse,
  acceptTruncatedText: boolean,
  diagnostics?: OpenRouterDiagnostics,
): OpenRouterTextGeneration {
  if (diagnostics) {
    diagnostics.phase = "output_validation";
    Object.assign(diagnostics, openRouterTokenCounts(data.usage));
  }
  const choice = data.choices?.[0];
  if (!choice) {
    recordOutputDetail(
      diagnostics,
      data.error !== undefined ? "completion_error" : "missing_choices",
    );
    if (data.error !== undefined) {
      throw openRouterRequestError({
        message: "OpenRouter request failed",
        status: 502,
        origin: "completion",
        value: data,
      });
    }
    throw new Error("OpenRouter returned no choices");
  }
  if (diagnostics) {
    diagnostics.finishReason = safeDiagnosticString(choice.finish_reason, [
      "stop",
      "length",
      "content_filter",
      "tool_calls",
      "error",
    ]);
    diagnostics.nativeFinishReason = safeDiagnosticString(
      choice.native_finish_reason,
      ["MAX_TOKENS", "STOP", "SAFETY", "RECITATION", "OTHER"],
    );
  }
  if (choice.finish_reason === "error") {
    recordOutputDetail(diagnostics, "completion_error");
    throw openRouterRequestError({
      message: "OpenRouter completion failed",
      status: 502,
      origin: "completion",
      value: choice.error ?? data.error,
    });
  }
  const rawContent = choice.message?.content;
  if (choice.finish_reason !== "stop") {
    recordOutputDetail(diagnostics, "non_stop");
    const nativeFinishReason = safeDiagnosticString(
      choice.native_finish_reason,
      ["MAX_TOKENS", "STOP", "SAFETY", "RECITATION", "OTHER"],
    );
    const finishReason = safeDiagnosticString(choice.finish_reason, [
      "length",
      "content_filter",
      "tool_calls",
    ]);
    const partial = typeof rawContent === "string" ? rawContent.trim() : "";
    if (acceptTruncatedText && finishReason === "length" && partial) {
      return generation(partial, data.usage, true);
    }
    const nativeReason = nativeFinishReason
      ? ` (native: ${nativeFinishReason})`
      : "";
    const error = new Error(
      `OpenRouter completion finished with ${finishReason ?? "unknown"}${nativeReason}`,
    );
    const reason = incompleteFinishReason(finishReason);
    if (reason) {
      recordOpenRouterFailure(error, reason);
      recordOpenRouterFailureTokenCounts(
        error,
        openRouterTokenCounts(data.usage),
      );
    }
    throw error;
  }

  if (typeof rawContent !== "string") {
    recordOutputDetail(diagnostics, "invalid_content");
    throw new Error("OpenRouter returned invalid content");
  }
  const content = rawContent.trim();
  if (!content) {
    recordOutputDetail(diagnostics, "empty_content");
    throw new Error("OpenRouter returned empty content");
  }
  return generation(content, data.usage, false);
}

function generation(
  text: string,
  usage: OpenRouterUsage | undefined,
  truncated: boolean,
): OpenRouterTextGeneration {
  return {
    text,
    ...(usage === undefined ? {} : { usage }),
    ...(truncated ? { truncated } : {}),
  };
}

/**
 * Whether OpenRouter-backed text generation is available. Callers gate optional
 * LLM enrichment on this so the surrounding feature degrades when the key is
 * unset (e.g. local dev) instead of throwing.
 */
export function isLlmConfigured(): boolean {
  return Boolean(optionalEnv("OPENROUTER_API_KEY"));
}

/**
 * Call OpenRouter chat completions and return the trimmed first-choice text.
 * Returns `null` when no API key is configured. HTTP/parse failures throw so
 * the caller can decide how to degrade (typically by wrapping in `settle`).
 */
export async function generateText(
  model: string,
  messages: readonly OpenRouterMessage[],
  maxTokens?: number,
  options?: OpenRouterGenerateTextOptions,
  signal?: AbortSignal,
): Promise<string | null> {
  const generation = await generateTextWithUsage(
    model,
    messages,
    maxTokens,
    options,
    signal,
  );
  return generation?.text ?? null;
}

/**
 * Call OpenRouter chat completions and return both text and provider-reported
 * usage. The usage payload is intentionally passed through with OpenRouter's
 * snake_case fields so billing code can stay aligned with their API surface.
 */
export async function generateTextWithUsage(
  model: string,
  messages: readonly OpenRouterMessage[],
  maxTokens?: number,
  options?: OpenRouterGenerateTextOptions,
  signal?: AbortSignal,
): Promise<OpenRouterTextGeneration | null> {
  const apiKey = optionalEnv("OPENROUTER_API_KEY");
  if (!apiKey) {
    return null;
  }

  const diagnostics = options?.diagnostics;
  if (diagnostics) {
    diagnostics.phase = "fetch";
  }
  const response = await onRejection(
    fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
        ...(options?.reasoning === undefined
          ? {}
          : { reasoning: options.reasoning }),
        temperature: options?.temperature ?? 0.3,
      }),
      signal,
    }),
    recordOpenRouterTransportFailure,
  );
  if (diagnostics) {
    diagnostics.upstreamStatus = response.status;
    diagnostics.phase = "status";
  }
  await onRejection(
    ensureOpenRouterResponseOk(response, diagnostics),
    recordOpenRouterTransportFailure,
  );
  if (diagnostics) {
    diagnostics.phase = "body_read";
  }
  const body = await onRejection(
    response.text(),
    recordOpenRouterTransportFailure,
  );
  if (diagnostics) {
    diagnostics.phase = "json_validation";
  }
  const parsed = safeSync(() => {
    // Preserve the shared helper's payload-free parsing and throw contract.
    const data = safeJsonParse(body);
    if (typeof data !== "object" || data === null) {
      if (diagnostics) {
        diagnostics.detail = "invalid_json";
      }
      throw new Error("OpenRouter returned invalid JSON");
    }
    return parseOpenRouterGeneration(
      data as OpenRouterResponse,
      options?.acceptTruncatedText === true,
      diagnostics,
    );
  });
  if ("error" in parsed) {
    // Only classify what nothing else has. A reason recorded at the throw site
    // is more specific than this fallback, and overwriting it would erase the
    // one signal that separates an expected outcome from a defect.
    if (
      !(parsed.error instanceof OpenRouterRequestError) &&
      openRouterFailureReason(parsed.error) === "unknown"
    ) {
      recordOpenRouterFailure(parsed.error, "invalid_output");
    }
    throw parsed.error;
  }
  return parsed.ok;
}
