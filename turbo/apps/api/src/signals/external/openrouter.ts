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
  recordOpenRouterRequestFailure,
  recordOpenRouterTransportFailure,
  type OpenRouterTokenCounts,
} from "./openrouter-failure";

export const OPENROUTER_DECISIONS_URL =
  "https://openrouter.ai/api/alpha/decisions";
const OPENROUTER_ERROR_RESPONSE_MAX_BYTES = 64 * 1024;

export interface OpenRouterTokenDetails {
  readonly cached_tokens?: number;
  readonly cache_write_tokens?: number;
  readonly reasoning_tokens?: number;
}

export interface OpenRouterUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  /** Decisions API names for the same two counters. */
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly prompt_tokens_details?: OpenRouterTokenDetails;
  readonly completion_tokens_details?: OpenRouterTokenDetails;
}

export interface OpenRouterDecisionsGeneration {
  readonly value: Readonly<Record<string, unknown>>;
  readonly usage?: OpenRouterUsage;
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
    ["invalid_request_error"],
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

async function ensureOpenRouterResponseOk(response: Response): Promise<void> {
  if (response.ok) {
    return;
  }
  const errorBody = await readBoundedResponseText(
    response,
    OPENROUTER_ERROR_RESPONSE_MAX_BYTES,
  );
  const errorValue =
    errorBody.kind === "text" ? safeJsonParse(errorBody.text) : undefined;
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
  const completionTokens = tokenCount(
    usage?.completion_tokens ?? usage?.output_tokens,
  );
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
 * Whether OpenRouter-backed text generation is available. Callers gate optional
 * LLM enrichment on this so the surrounding feature degrades when the key is
 * unset (e.g. local dev) instead of throwing.
 */
export function isLlmConfigured(): boolean {
  return Boolean(optionalEnv("OPENROUTER_API_KEY"));
}

/**
 * Submit one structured Decisions request through the authenticated and
 * classified OpenRouter boundary.
 */
export async function generateDecisions(
  request: {
    readonly model: string;
    readonly state: unknown;
    readonly questions: Readonly<Record<string, unknown>>;
    readonly user?: string;
  },
  signal?: AbortSignal,
): Promise<OpenRouterDecisionsGeneration | null> {
  const apiKey = optionalEnv("OPENROUTER_API_KEY");
  if (!apiKey) {
    return null;
  }

  const response = await onRejection(
    fetch(OPENROUTER_DECISIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal,
    }),
    recordOpenRouterTransportFailure,
  );
  await onRejection(
    ensureOpenRouterResponseOk(response),
    recordOpenRouterTransportFailure,
  );
  const body = await onRejection(
    response.text(),
    recordOpenRouterTransportFailure,
  );
  const parsed = safeSync(() => {
    const data = safeJsonParse(body);
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new Error("OpenRouter returned an invalid Decisions response");
    }
    if ("error" in data && data.error !== undefined) {
      throw openRouterRequestError({
        message: "OpenRouter Decisions request failed",
        status: 502,
        origin: "completion",
        value: data,
      });
    }
    if (!("answers" in data)) {
      throw new Error("OpenRouter returned an invalid Decisions response");
    }
    const value = data as Record<string, unknown>;
    const usage = value.usage;
    return {
      value,
      ...(typeof usage === "object" && usage !== null && !Array.isArray(usage)
        ? { usage: usage as OpenRouterUsage }
        : {}),
    };
  });
  if ("error" in parsed) {
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
