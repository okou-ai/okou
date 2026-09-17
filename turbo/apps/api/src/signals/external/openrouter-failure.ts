import { singleton } from "../../lib/singleton";

/** Origin evidence only; annotating preserves the error identity for shared callers. */
export type OpenRouterFailureReason =
  | "rate_limited"
  | "upstream_timeout"
  | "network"
  | "provider_unavailable"
  | "invalid_request"
  | "auth"
  // The model stopped at the token budget. Reasoning models draw thinking and
  // visible output from one budget, so this is an expected capacity outcome
  // rather than a defect in the request or the provider.
  | "output_truncated"
  // The completion terminated as a tool call although no tools were offered.
  | "unexpected_tool_calls"
  | "invalid_output"
  | "unknown";

/** Provider-reported token counts, bounded to integers; never payload data. */
export interface OpenRouterTokenCounts {
  readonly completionTokens?: number;
  readonly reasoningTokens?: number;
}

/**
 * Optional, caller-owned observation for one attempt. Only first-party finite
 * values enter it; it never holds a response, exception, or provider string.
 * Keeping it separate also preserves primitive rejection and error identity.
 */
export interface OpenRouterDiagnostics extends OpenRouterTokenCounts {
  phase:
    | "configuration"
    | "fetch"
    | "status"
    | "body_read"
    | "json_validation"
    | "output_validation"
    | "usage_validation"
    | "settlement";
  detail?:
    | "invalid_json"
    | "missing_choices"
    | "completion_error"
    | "non_stop"
    | "invalid_content"
    | "empty_content";
  upstreamStatus?: number;
  finishReason?: "stop" | "length" | "content_filter" | "tool_calls" | "error";
  nativeFinishReason?:
    | "MAX_TOKENS"
    | "STOP"
    | "SAFETY"
    | "RECITATION"
    | "OTHER";
}

const failureReasons = singleton(() => {
  return new WeakMap<object, OpenRouterFailureReason>();
});

const failureTokenCounts = singleton(() => {
  return new WeakMap<object, OpenRouterTokenCounts>();
});

export function openRouterFailureReason(
  error: unknown,
): OpenRouterFailureReason {
  return typeof error === "object" && error !== null
    ? (failureReasons().get(error) ?? "unknown")
    : "unknown";
}

/**
 * The provider was reachable-but-unusable for reasons no caller can act on:
 * limits, timeouts, transport and upstream unavailability. Optional generations
 * use this to count an expected omission instead of reporting a defect. It
 * deliberately excludes budget and output-contract outcomes, which describe our
 * own request rather than the provider's availability.
 */
export function isTransientProviderFailure(
  reason: OpenRouterFailureReason,
): boolean {
  return (
    reason === "rate_limited" ||
    reason === "upstream_timeout" ||
    reason === "network" ||
    reason === "provider_unavailable"
  );
}

export function recordOpenRouterFailure(
  error: unknown,
  reason: OpenRouterFailureReason,
): void {
  if (typeof error === "object" && error !== null) {
    failureReasons().set(error, reason);
  }
}

/**
 * Token counts belonging to the completion that produced this failure. A
 * truncated completion still reports usage, and that usage is the only direct
 * evidence of how much of the shared budget the model spent on thinking.
 */
export function recordOpenRouterFailureTokenCounts(
  error: unknown,
  counts: OpenRouterTokenCounts,
): void {
  if (typeof error === "object" && error !== null) {
    failureTokenCounts().set(error, counts);
  }
}

export function openRouterFailureTokenCounts(
  error: unknown,
): OpenRouterTokenCounts {
  return typeof error === "object" && error !== null
    ? (failureTokenCounts().get(error) ?? {})
    : {};
}

function property(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value
    ? value[key as keyof typeof value]
    : undefined;
}

/**
 * The HTTP status is absent for a completion envelope, and the provider code is
 * absent for a bare transport status, so each class is a single enumerated set
 * matched against whichever of the two is present.
 */
function matchesFailure(
  candidates: readonly (string | number)[],
  httpStatus: number | undefined,
  code: unknown,
): boolean {
  return candidates.some((candidate) => {
    return candidate === httpStatus || candidate === code;
  });
}

function requestFailureReason(
  httpStatus: number | undefined,
  code: unknown,
  errorType: unknown,
): OpenRouterFailureReason {
  if (matchesFailure([401, 403], httpStatus, code)) {
    return "auth";
  }
  if (
    matchesFailure(
      [
        400,
        402,
        404,
        413,
        422,
        "invalid_request_error",
        "invalid_argument",
        "invalid_parameter",
        "unsupported_parameter",
        "unsupported_value",
        "INVALID_ARGUMENT",
      ],
      httpStatus,
      code,
    ) ||
    errorType === "invalid_request_error"
  ) {
    return "invalid_request";
  }
  if (
    matchesFailure(
      [429, "rate_limit_exceeded", "RESOURCE_EXHAUSTED"],
      httpStatus,
      code,
    ) ||
    errorType === "rate_limit_exceeded"
  ) {
    return "rate_limited";
  }
  // OpenRouter also delivers an upstream gateway failure inside a 200 body, as
  // an error envelope with no choices. The wrapper status is then a local
  // synthetic 502 and only the provider code carries the real outcome, so these
  // two classes match the code the way the rate-limit class already does. Both
  // stay last, leaving an enumerated invalid-request or auth code overriding a
  // transient status exactly as before.
  if (matchesFailure([408, 504], httpStatus, code)) {
    return "upstream_timeout";
  }
  if (matchesFailure([502, 503, "UNAVAILABLE"], httpStatus, code)) {
    return "provider_unavailable";
  }
  return "unknown";
}

export function recordOpenRouterRequestFailure(
  error: Error,
  status: number,
  origin: "http" | "completion",
  value: unknown,
): void {
  const detail = property(value, "error") ?? value;
  recordOpenRouterFailure(
    error,
    requestFailureReason(
      origin === "http" ? status : undefined,
      property(error, "errorCode") ?? property(detail, "code"),
      property(property(detail, "metadata"), "error_type"),
    ),
  );
}

/** Call only at fetch/body I/O, never around feature code or output interpretation. */
export function recordOpenRouterTransportFailure(error: unknown): void {
  const code =
    property(property(error, "cause"), "code") ?? property(error, "code");
  if (
    typeof code === "string" &&
    [
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
      "ETIMEDOUT",
    ].includes(code)
  ) {
    recordOpenRouterFailure(error, "upstream_timeout");
  } else if (
    (typeof code === "string" &&
      [
        "ECONNRESET",
        "ECONNREFUSED",
        "EAI_AGAIN",
        "ENOTFOUND",
        "ENETUNREACH",
        "UND_ERR_SOCKET",
      ].includes(code)) ||
    (code === undefined &&
      error instanceof TypeError &&
      (error.message === "fetch failed" || error.message === "Failed to fetch"))
  ) {
    recordOpenRouterFailure(error, "network");
  }
}
