import {
  readBoundedResponseText,
  safeJsonParse,
  settleIncludingAbort,
} from "../utils";
import { OPENROUTER_CHAT_COMPLETIONS_URL } from "./openrouter";

/**
 * The narrow platform-funded OpenRouter transport.
 *
 * `generateTextWithUsage` exists for auxiliary text: it throws on anything it
 * cannot turn into a usable string, reads successful bodies without a ceiling,
 * and discards the generation id and the reported cost. A platform-funded
 * request needs the opposite contract, so this is a separate adapter rather
 * than a change to that one — every existing caller keeps its behavior.
 *
 * What this adapter guarantees:
 *
 * - **Billing survives validation.** It returns what the provider reported —
 *   generation id, served model, native token counts and `usage.cost` — as a
 *   plain observation. Deciding whether the content is usable happens after,
 *   so invalid output still leaves an exact spend record.
 * - **Every body is bounded.** Success and error bodies are both read through
 *   `readBoundedResponseText`, so an oversized response is a finite outcome
 *   instead of unbounded memory.
 * - **Nothing is inferred.** A missing or malformed cost is unknown, never
 *   zero and never derived from token counts. An explicitly reported zero is a
 *   known zero.
 * - **No payload escapes.** It never throws provider text, never logs a body
 *   and never carries the credential into its result.
 *
 * Provider contract, verified against the [official usage-accounting
 * documentation](https://openrouter.ai/docs/cookbook/administration/usage-accounting)
 * on 2026-09-17: every non-streaming response carries `usage` with native
 * `prompt_tokens`/`completion_tokens`/`total_tokens`, optional
 * `completion_tokens_details.reasoning_tokens` and
 * `prompt_tokens_details.cached_tokens`, and `cost` — documented as "the total
 * amount charged to your account", in OpenRouter credits. The `usage.include`
 * and `stream_options.include_usage` request flags are deprecated no-ops, so
 * nothing is sent to request usage. `cost_details.upstream_inference_cost` is
 * the upstream provider's charge and is documented as BYOK-only — zero or null
 * for platform-managed requests — so it is deliberately never read here.
 */

/** Success bodies above this are unreadable rather than unbounded. */
const PLATFORM_SUCCESS_RESPONSE_MAX_BYTES = 256 * 1024;
/** Error bodies are smaller still; only the status is retained from them. */
const PLATFORM_ERROR_RESPONSE_MAX_BYTES = 64 * 1024;

/** The only unit this adapter can report. Never Okou credits, never a currency. */
export const OPENROUTER_COST_UNIT = "openrouter_credits";
/** The exact field a reported cost was parsed from. */
export const OPENROUTER_COST_SOURCE = "chat_completion_usage_cost";

export type PlatformGenerationFinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "error"
  | "other";

export interface PlatformGenerationTokens {
  readonly prompt: number | null;
  readonly completion: number | null;
  readonly reasoning: number | null;
  readonly cached: number | null;
  readonly total: number | null;
}

export type PlatformGenerationCost =
  | {
      readonly state: "reported";
      /** The provider's own value, serialized without conversion or rounding. */
      readonly value: string;
      readonly unit: typeof OPENROUTER_COST_UNIT;
      readonly source: typeof OPENROUTER_COST_SOURCE;
    }
  | { readonly state: "unavailable" };

/** Everything one readable provider response reported. */
export interface PlatformGenerationObservation {
  readonly generationId: string | null;
  readonly returnedModel: string | null;
  readonly finishReason: PlatformGenerationFinishReason | null;
  /** The first choice's message content, exactly as returned. */
  readonly content: string | null;
  /** True when the response reported a choice-level or top-level error. */
  readonly completionError: boolean;
  readonly tokens: PlatformGenerationTokens;
  readonly cost: PlatformGenerationCost;
}

export type PlatformGenerationOutcome =
  | {
      readonly kind: "response";
      readonly observation: PlatformGenerationObservation;
    }
  /** The provider answered with a non-success status. Cost is unknown. */
  | { readonly kind: "provider-error"; readonly status: number }
  /** A response arrived but exceeded the byte ceiling or was not JSON. */
  | { readonly kind: "response-unreadable" }
  /**
   * The request never produced a readable response. It may still have reached
   * the provider, so this is explicitly not "never invoked".
   */
  | { readonly kind: "transport-failed" };

function property(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return undefined;
  }
  return value[key as keyof typeof value];
}

/** Provider counts are untrusted numbers; keep only bounded non-negative integers. */
function tokenCount(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
    ? Math.trunc(value)
    : null;
}

function readTokens(usage: unknown): PlatformGenerationTokens {
  return {
    prompt: tokenCount(property(usage, "prompt_tokens")),
    completion: tokenCount(property(usage, "completion_tokens")),
    reasoning: tokenCount(
      property(
        property(usage, "completion_tokens_details"),
        "reasoning_tokens",
      ),
    ),
    cached: tokenCount(
      property(property(usage, "prompt_tokens_details"), "cached_tokens"),
    ),
    total: tokenCount(property(usage, "total_tokens")),
  };
}

/**
 * Read `usage.cost` and nothing else.
 *
 * Only a finite, non-negative JSON number counts. A string, a negative value,
 * `NaN`, a missing `usage` object and a missing field are all *unavailable*,
 * which is distinct from a reported `0`.
 */
function readCost(usage: unknown): PlatformGenerationCost {
  const cost = property(usage, "cost");
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
    return { state: "unavailable" };
  }
  return {
    state: "reported",
    value: String(cost),
    unit: OPENROUTER_COST_UNIT,
    source: OPENROUTER_COST_SOURCE,
  };
}

/** Untrusted identifier-shaped strings are bounded before they are retained. */
function boundedIdentifier(value: unknown, maxLength: number): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength
    ? value
    : null;
}

function readFinishReason(
  value: unknown,
): PlatformGenerationFinishReason | null {
  if (typeof value !== "string") {
    return null;
  }
  const known: readonly PlatformGenerationFinishReason[] = [
    "stop",
    "length",
    "tool_calls",
    "content_filter",
    "error",
  ];
  return (
    known.find((candidate) => {
      return candidate === value;
    }) ?? "other"
  );
}

function observe(data: unknown): PlatformGenerationObservation {
  const usage = property(data, "usage");
  const choices = property(data, "choices");
  const choice = Array.isArray(choices) ? (choices[0] as unknown) : undefined;
  const content = property(property(choice, "message"), "content");
  return {
    generationId: boundedIdentifier(property(data, "id"), 256),
    returnedModel: boundedIdentifier(property(data, "model"), 256),
    finishReason: readFinishReason(property(choice, "finish_reason")),
    content: typeof content === "string" ? content : null,
    completionError:
      property(data, "error") !== undefined ||
      property(choice, "error") !== undefined,
    tokens: readTokens(usage),
    cost: readCost(usage),
  };
}

interface PlatformGenerationRequest {
  readonly apiKey: string;
  /**
   * The exact serialized request body. The caller measures it against its own
   * ceiling and then sends those exact bytes, so nothing can grow between the
   * size check and the request.
   */
  readonly body: string;
}

/**
 * Send one non-streaming platform-funded chat completion.
 *
 * This never retries: the caller owns a durable reservation and a request that
 * may already have reached the provider must not be sent again. Cancellation is
 * settled rather than propagated, because an aborted request is exactly the
 * ambiguous case the caller has to record instead of discard.
 */
export async function requestPlatformGeneration(
  request: PlatformGenerationRequest,
  signal: AbortSignal,
): Promise<PlatformGenerationOutcome> {
  const responded = await settleIncludingAbort(
    fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.apiKey}`,
        "Content-Type": "application/json",
      },
      body: request.body,
      signal,
    }),
  );
  if (!responded.ok) {
    return { kind: "transport-failed" };
  }
  const response = responded.value;
  if (!response.ok) {
    // The status is the whole signal. The body is drained under a ceiling so a
    // hostile or broken error payload cannot be retained or leak into a log.
    await settleIncludingAbort(
      readBoundedResponseText(response, PLATFORM_ERROR_RESPONSE_MAX_BYTES),
    );
    return { kind: "provider-error", status: response.status };
  }
  const body = await settleIncludingAbort(
    readBoundedResponseText(response, PLATFORM_SUCCESS_RESPONSE_MAX_BYTES),
  );
  if (!body.ok) {
    return { kind: "transport-failed" };
  }
  if (body.value.kind !== "text") {
    return { kind: "response-unreadable" };
  }
  const data = safeJsonParse(body.value.text);
  if (typeof data !== "object" || data === null) {
    return { kind: "response-unreadable" };
  }
  return { kind: "response", observation: observe(data) };
}

/** The token counts an outcome without a readable response can still record. */
export function unknownInvocationTokens(): PlatformGenerationTokens {
  return {
    prompt: null,
    completion: null,
    reasoning: null,
    cached: null,
    total: null,
  };
}
