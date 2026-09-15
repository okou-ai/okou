import type { KnownRunFailureReason } from "./run-failure-reasons";

const PROVIDER_FAILURE_CODES = new Map<string, KnownRunFailureReason>([
  ["invalid_api_key", "invalid_api_key"],
  ["authentication_error", "invalid_credentials"],
  ["context_length_exceeded", "context_window_exceeded"],
  ["context_window_exceeded", "context_window_exceeded"],
  ["prompt_too_long", "context_window_exceeded"],
  ["rate_limit_exceeded", "provider_rate_limited"],
  ["rate_limit_error", "provider_rate_limited"],
  ["overloaded_error", "provider_overloaded"],
  ["server_overloaded", "provider_overloaded"],
  ["server_error", "provider_server_error"],
  ["internal_server_error", "provider_server_error"],
  ["insufficient_quota", "usage_limit"],
  ["usage_limit_reached", "usage_limit"],
  ["usage_not_included", "usage_limit"],
  ["billing_hard_limit_reached", "usage_limit"],
  ["insufficient_credits", "insufficient_credits"],
  ["content_policy_violation", "safety_policy_refusal"],
  ["model_not_found", "unsupported_model"],
  ["unsupported_model", "unsupported_model"],
]);

/** Only call at a failed model request/result boundary, never on tool or answer text. */
export function classifyProviderFailure(
  message: string,
  httpStatus?: number,
): KnownRunFailureReason | undefined {
  const payload = providerErrorPayload(message);
  const reason = payload && providerErrorReason(payload);
  if (reason) return reason;

  const errorMessage = payload && object(payload.error)?.message;
  const normalized = (typeof errorMessage === "string" ? errorMessage : message)
    .trim()
    .toLowerCase();
  if (
    /^(?:codex error: )?our servers are currently overloaded\. please try again later\.$/u.test(
      normalized,
    ) ||
    normalized ===
      "selected model is at capacity. please try a different model."
  )
    return "provider_overloaded";
  if (
    /^(?:codex error: )?(?:you(?:'ve| have) hit your (?:chatgpt )?usage limit|you(?:'ve| have) hit your (?:session|weekly) limit)\b/u.test(
      normalized,
    )
  )
    return "usage_limit";
  if (normalized === "terminated") return "response_connection_lost";
  if (
    /^codex sse response (?:headers|body) timed out after \d+ms$/u.test(
      normalized,
    )
  ) {
    return "provider_stream_timeout";
  }
  if (
    /^(?:\d{3} )?invalid_api_key\b/u.test(normalized) ||
    normalized.startsWith("incorrect api key provided")
  ) {
    return "invalid_api_key";
  }
  if (
    normalized.startsWith(
      "codex ran out of room in the model's context window.",
    ) &&
    (normalized.includes("start a new thread") ||
      normalized.includes("start a new conversation")) &&
    normalized.includes("clear earlier history") &&
    normalized.includes("before retrying")
  ) {
    return "context_window_exceeded";
  }
  return classifyProviderHttpFailure(httpStatus);
}

export function classifyProviderHttpFailure(
  status: number | undefined,
): KnownRunFailureReason | undefined {
  if (status === 429) return "provider_rate_limited";
  if (status === 529) return "provider_overloaded";
  if (
    status !== undefined &&
    Number.isInteger(status) &&
    status >= 500 &&
    status <= 599
  ) {
    return "provider_server_error";
  }
  return undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function providerErrorPayload(
  message: string,
): Record<string, unknown> | undefined {
  const start = message.indexOf("{");
  if (start < 0) return undefined;
  const prefix = message.slice(0, start).trim().toLowerCase();
  if (
    !(
      prefix === "" ||
      prefix === "codex error:" ||
      /^(?:api error: |unexpected status |\d{3}(?:\s|$))/u.test(prefix)
    )
  )
    return undefined;
  try {
    return object(JSON.parse(message.slice(start)) as unknown);
  } catch {
    return undefined;
  }
}

function providerErrorReason(
  payload: Record<string, unknown>,
): KnownRunFailureReason | undefined {
  const error = object(payload.error) ?? payload;
  if (error.error === "insufficient_credits") return "insufficient_credits";
  if (
    (error.error === "TOKEN_REFRESH_FAILED" ||
      error.code === "TOKEN_REFRESH_FAILED") &&
    error.failureReason === "reconnect_required" &&
    Array.isArray(error.connectors) &&
    error.connectors.length === 1 &&
    error.connectors[0] === "codex-oauth-token"
  )
    return "reconnect_required";

  const code = typeof error.code === "string" ? error.code : error.type;
  const reason =
    typeof code === "string" ? PROVIDER_FAILURE_CODES.get(code) : undefined;
  if (reason) return reason;
  if (
    code === "invalid_request_error" &&
    typeof error.message === "string" &&
    /^prompt is too long: \d+ tokens? > \d+ maximum$/iu.test(error.message)
  ) {
    return "context_window_exceeded";
  }
  if (
    error.type === "invalid_request_error" &&
    error.code === "invalid_request_error" &&
    error.message === "Content Exists Risk"
  ) {
    return "safety_policy_refusal";
  }
  return undefined;
}
