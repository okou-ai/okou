import {
  MORNING_BRIEF_PLATFORM_RECEIPT_COST_PRECISION,
  MORNING_BRIEF_PLATFORM_RECEIPT_COST_SCALE,
  MORNING_BRIEF_PLATFORM_RECEIPT_MAX_TOKENS,
} from "@okouai/db/schema/morning-brief-generation";

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
 * - **Every observation is durable as observed.** Counts and amounts are
 *   accepted against the exact domain the receipt columns hold, so what this
 *   adapter reports is what PostgreSQL stores and returns. A value outside that
 *   domain is *unavailable*: it is never rounded into an invented measurement,
 *   and it never takes a valid sibling field or a valid cost down with it.
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

const OPENROUTER_GENERATION_URL = "https://openrouter.ai/api/v1/generation";

/** Success bodies above this are unreadable rather than unbounded. */
const PLATFORM_SUCCESS_RESPONSE_MAX_BYTES = 256 * 1024;

/** The read-only cost lookup returns one small metadata record. */
const PLATFORM_GENERATION_RESPONSE_MAX_BYTES = 64 * 1024;
/** Error bodies are smaller still; only the status is retained from them. */
const PLATFORM_ERROR_RESPONSE_MAX_BYTES = 64 * 1024;

/** The only unit this adapter can report. Never Okou credits, never a currency. */
const OPENROUTER_COST_UNIT = "openrouter_credits";
/** The exact field a reported cost was parsed from. */
const OPENROUTER_COST_SOURCE = "chat_completion_usage_cost";
/** The read-only lookup's own field, kept distinct from the inline one. */
const OPENROUTER_GENERATION_COST_SOURCE = "generation_total_cost";

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

export type PlatformGenerationCostSource =
  | typeof OPENROUTER_COST_SOURCE
  | typeof OPENROUTER_GENERATION_COST_SOURCE;

export type PlatformGenerationCost =
  | {
      readonly state: "reported";
      /** The provider's own value, serialized without conversion or rounding. */
      readonly value: string;
      readonly unit: typeof OPENROUTER_COST_UNIT;
      readonly source: PlatformGenerationCostSource;
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
  /**
   * True when the choice actually carries tool calls.
   *
   * Observed from the message rather than inferred from `finish_reason`: a
   * provider can return `stop` alongside a populated tool-call field, and this
   * pipeline sends no tools, so either signal alone is enough to refuse the
   * output.
   */
  readonly toolCalls: boolean;
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

/**
 * Provider counts are untrusted numbers; keep only counts the receipt holds.
 *
 * A fractional or out-of-range count is *unavailable*, not something to round:
 * truncating it would manufacture an exact-looking number the provider never
 * reported. The ceiling is the receipt column's own domain rather than
 * `Number.MAX_SAFE_INTEGER`, because a count above it is not stored wider — it
 * fails the whole INSERT and takes the observed cost and every sibling count
 * with it.
 */
function tokenCount(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MORNING_BRIEF_PLATFORM_RECEIPT_MAX_TOKENS
    ? value
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

/** The integral digits `numeric(precision, scale)` leaves for the amount. */
const COST_MAX_INTEGRAL_DIGITS =
  MORNING_BRIEF_PLATFORM_RECEIPT_COST_PRECISION -
  MORNING_BRIEF_PLATFORM_RECEIPT_COST_SCALE;

/** `<digits>[.<digits>][e<±digits>]`, the only shapes `String(number)` emits. */
const NUMBER_TEXT = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/**
 * The exact decimal the receipt column will hold, or `null` if it cannot.
 *
 * `String` gives the shortest decimal that round-trips the reported double, and
 * this shifts that decimal by its own exponent rather than reformatting through
 * floating point, so no digit is introduced or lost on the way. The result is
 * padded to the column's scale because that is the text PostgreSQL returns, so
 * one accepted amount reads back byte-identical to the amount first reported.
 *
 * An amount needing finer digits than the scale, or more integral digits than
 * the precision leaves, has no exact representation here. Rounding `1e-13` into
 * the scale would publish a *durable reported zero* for a real nonzero charge,
 * so such an amount stays unavailable — an honest unknown, with the generation
 * id retained for out-of-band reconciliation.
 */
function durableCostValue(cost: number): string | null {
  const parsed = NUMBER_TEXT.exec(String(cost));
  if (!parsed) {
    return null;
  }
  const [, whole = "", fraction = "", exponent = "0"] = parsed;
  const digits = `${whole}${fraction}`;
  const pointIndex = whole.length + Number(exponent);
  const integral =
    pointIndex <= 0 ? "0" : digits.slice(0, pointIndex).padEnd(pointIndex, "0");
  const fractional =
    pointIndex <= 0
      ? `${"0".repeat(-pointIndex)}${digits}`
      : digits.slice(pointIndex);
  const significantIntegral = integral.replace(/^0+(?=\d)/, "");
  const significantFractional = fractional.replace(/0+$/, "");
  if (
    significantIntegral.length > COST_MAX_INTEGRAL_DIGITS ||
    significantFractional.length > MORNING_BRIEF_PLATFORM_RECEIPT_COST_SCALE
  ) {
    return null;
  }
  return `${significantIntegral}.${significantFractional.padEnd(MORNING_BRIEF_PLATFORM_RECEIPT_COST_SCALE, "0")}`;
}

/**
 * Accept one reported amount, or report that none is known.
 *
 * Only a finite, non-negative JSON number the receipt column holds exactly
 * counts. A string, a negative value, `NaN`, a missing `usage` object, a
 * missing field and an amount outside the durable domain are all *unavailable*,
 * which is distinct from a reported `0`.
 */
function reportedCost(
  cost: unknown,
  source: PlatformGenerationCostSource,
): PlatformGenerationCost {
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
    return { state: "unavailable" };
  }
  const value = durableCostValue(cost);
  return value === null
    ? { state: "unavailable" }
    : { state: "reported", value, unit: OPENROUTER_COST_UNIT, source };
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
  const message = property(choice, "message");
  const content = property(message, "content");
  const toolCalls = property(message, "tool_calls");
  return {
    toolCalls: Array.isArray(toolCalls) && toolCalls.length > 0,
    generationId: boundedIdentifier(property(data, "id"), 256),
    returnedModel: boundedIdentifier(property(data, "model"), 256),
    finishReason: readFinishReason(property(choice, "finish_reason")),
    content: typeof content === "string" ? content : null,
    completionError:
      property(data, "error") !== undefined ||
      property(choice, "error") !== undefined,
    tokens: readTokens(usage),
    cost: reportedCost(property(usage, "cost"), OPENROUTER_COST_SOURCE),
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

/**
 * A bounded, read-only reconciliation of one already known generation id.
 *
 * Verified against the [official generation-metadata
 * reference](https://openrouter.ai/docs/api/api-reference/generations/get-request-&-usage-metadata-for-a-generation)
 * on 2026-09-17: `GET /api/v1/generation` takes a required `id` query
 * parameter and answers `{ data: { id, is_byok, total_cost,
 * upstream_inference_cost, native_tokens_* , ... } }`. `total_cost` is this
 * endpoint's form of the amount charged to the OpenRouter account, which the
 * usage-accounting page states in OpenRouter credits, and
 * `upstream_inference_cost` is the separate upstream charge that page documents
 * as BYOK-only. Those are different fields and only the first is ever read.
 *
 * Two guards keep an uncertain answer uncertain. A record whose `id` is not the
 * one asked for is discarded rather than attributed, and a `is_byok: true`
 * record is refused because a BYOK generation's charge is not this platform's
 * spend. Everything else — a 404, a delay that exceeds the deadline, a
 * transport failure, a malformed or missing amount — stays `unavailable`.
 *
 * This is reconciliation only. It sends no completion, cannot produce content,
 * and can never be a reason to send the original request again.
 */
export async function lookupPlatformGenerationCost(
  request: {
    readonly apiKey: string;
    readonly generationId: string;
  },
  signal: AbortSignal,
): Promise<PlatformGenerationCost> {
  const url = new URL(OPENROUTER_GENERATION_URL);
  url.searchParams.set("id", request.generationId);
  const responded = await settleIncludingAbort(
    fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${request.apiKey}` },
      signal,
    }),
  );
  if (!responded.ok || !responded.value.ok) {
    if (responded.ok) {
      await settleIncludingAbort(
        readBoundedResponseText(
          responded.value,
          PLATFORM_GENERATION_RESPONSE_MAX_BYTES,
        ),
      );
    }
    return { state: "unavailable" };
  }
  const body = await settleIncludingAbort(
    readBoundedResponseText(
      responded.value,
      PLATFORM_GENERATION_RESPONSE_MAX_BYTES,
    ),
  );
  if (!body.ok || body.value.kind !== "text") {
    return { state: "unavailable" };
  }
  const data = property(safeJsonParse(body.value.text), "data");
  if (property(data, "id") !== request.generationId) {
    // A record for a different generation says nothing about this one.
    return { state: "unavailable" };
  }
  if (property(data, "is_byok") !== false) {
    // A BYOK generation's upstream charge is not the platform's spend, and an
    // absent flag is not evidence that it was platform-funded.
    return { state: "unavailable" };
  }
  // The same durable contract as the inline amount: a delayed reconciliation
  // is no reason to accept a value the receipt cannot hold exactly.
  return reportedCost(
    property(data, "total_cost"),
    OPENROUTER_GENERATION_COST_SOURCE,
  );
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
