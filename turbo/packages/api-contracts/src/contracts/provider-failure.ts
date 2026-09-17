import type { KnownRunFailureReason } from "./run-failure-reasons";
import { isProviderBalanceErrorBody } from "./run-balance-errors";

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
  ["usage_limit_reached", "usage_limit"],
  ["usage_not_included", "usage_limit"],
  ["content_policy_violation", "safety_policy_refusal"],
  ["model_not_found", "unsupported_model"],
  ["unsupported_model", "unsupported_model"],
  ["ThrottlingException", "provider_rate_limited"],
  ["throttlingException", "provider_rate_limited"],
  ["ServiceUnavailableException", "provider_server_error"],
  ["serviceUnavailableException", "provider_server_error"],
  ["InternalServerException", "provider_server_error"],
  ["internalServerException", "provider_server_error"],
]);

/** A provider-owned error code, never a word extracted from ordinary output. */
export function classifyProviderFailureCode(
  code: unknown,
): KnownRunFailureReason | undefined {
  return typeof code === "string"
    ? PROVIDER_FAILURE_CODES.get(code)
    : undefined;
}

/** Only call at a failed model request/result boundary, never on tool or answer text. */
export function classifyProviderFailure(
  message: string,
  httpStatus?: number,
): KnownRunFailureReason | undefined {
  const payload = providerErrorPayload(message);
  const reason = payload && providerErrorReason(payload);
  // Billing requires provider provenance: an observed response or a native API
  // error prefix. A bare JSON fragment in a terminal message is not sufficient.
  if (
    reason === "provider_insufficient_credits" &&
    !hasProviderErrorProvenance(message, httpStatus)
  )
    return undefined;
  if (
    reason &&
    reason !== "provider_server_error" &&
    reason !== "provider_overloaded"
  )
    return reason;

  const errorMessage = payload && (object(payload.error) ?? payload).message;
  const normalized = (typeof errorMessage === "string" ? errorMessage : message)
    .trim()
    .toLowerCase()
    .replace(/^codex error: /u, "");
  const textReason = providerTextFailureReason(normalized);
  return textReason === "provider_queue_timeout"
    ? textReason
    : (reason ?? textReason ?? classifyProviderHttpFailure(httpStatus));
}

function providerTextFailureReason(
  normalized: string,
): KnownRunFailureReason | undefined {
  if (
    normalized.replace(
      /^(?:error code )?(?:unknown|server_error|internal_server_error|overloaded_error|server_overloaded|timeout): /u,
      "",
    ) ===
    "we were unable to start processing your request within the 900-second timeout limit. please try again later."
  )
    return "provider_queue_timeout";
  // Responses SDKs prefix code-less stream failures with `unknown:`. Strip
  // only their generic request wrappers before matching an exact provider phrase.
  const semanticMessage = normalized.replace(
    /^(?:error code )?(?:unknown|invalid_request_error): /u,
    "",
  );
  if (
    semanticMessage ===
      "our servers are currently overloaded. please try again later." ||
    semanticMessage ===
      "selected model is at capacity. please try a different model."
  )
    return "provider_overloaded";
  if (
    semanticMessage.startsWith(
      "invalid prompt: your prompt was flagged as potentially violating our usage policy. please try again with a different prompt: ",
    )
  )
    return "safety_policy_refusal";
  if (
    /^(?:you(?:'ve| have) hit your (?:chatgpt )?usage limit|you(?:'ve| have) hit your (?:session|weekly) limit)\b/u.test(
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
  return undefined;
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

function hasProviderErrorProvenance(
  message: string,
  httpStatus: number | undefined,
): boolean {
  return (
    (httpStatus !== undefined &&
      Number.isInteger(httpStatus) &&
      httpStatus >= 100 &&
      httpStatus <= 599) ||
    /^(?:api error: |unexpected status )/iu.test(message.trim())
  );
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
      /^(?:openai|anthropic) api error \(\d{3}\):$/u.test(prefix) ||
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
  if (isProviderBalanceErrorBody({ error })) {
    return "provider_insufficient_credits";
  }
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
  const reason = classifyProviderFailureCode(code);
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
