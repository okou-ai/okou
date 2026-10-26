import { randomUUID } from "node:crypto";
import { object, string, union, enum as zEnum, unknown as zUnknown } from "zod";

import { logger } from "../../lib/log";
import { monotonicNow } from "../../lib/time";

const L = logger("api:link-wallet");
export type LinkOperation =
  | "oauth_exchange"
  | "oauth_refresh"
  | "oauth_revoke"
  | "spend_create"
  | "spend_read"
  | "spend_credentials"
  | "spend_cancel"
  | "spend_approval"
  | "transactions_read"
  | "payment_methods_read"
  | "payment_method_read"
  | "user_info_read";

export interface LinkRequestDiagnostic {
  readonly diagnosticId: string;
  readonly operation: LinkOperation;
  readonly startedAt: number;
  readonly sensitiveValues: readonly string[];
  readonly intentId?: string;
  readonly requestSummary?: {
    amount: number;
    currency: "usd";
    test: boolean;
    contextLength: number;
  };
}

export function linkRequestDiagnostic(
  operation: LinkOperation,
  sensitiveValues: readonly string[],
  intentId?: string,
  requestSummary?: LinkRequestDiagnostic["requestSummary"],
): LinkRequestDiagnostic {
  return {
    diagnosticId: randomUUID(),
    operation,
    startedAt: monotonicNow(),
    sensitiveValues,
    intentId,
    requestSummary,
  };
}

// Unknown provider strings can contain credentials or personal data.
const providerErrorCodeSchema = zEnum([
  "invalid_request",
  "invalid_request_error",
  "parameter_invalid",
  "parameter_missing",
  "resource_missing",
  "rate_limit",
  "spend_request_rate_limited",
  "card_declined",
  "api_error",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "invalid_token",
  "insufficient_scope",
  "access_denied",
  "temporarily_unavailable",
  "server_error",
]);
const providerErrorSchema = object({
  error: union([string(), object({ code: string().optional() })]),
});
const providerMessageSchema = object({
  error: zUnknown().optional(),
  message: zUnknown().optional(),
  error_description: zUnknown().optional(),
  detail: zUnknown().optional(),
});
const providerRequestIdSchema = string().regex(/^req_[A-Za-z0-9]{1,80}$/);

// Keep the existing authentication labels; unfamiliar errors additionally carry
// a bounded explanation after the same redaction used for every provider stage.
const providerAuthMessageReasons = [
  [
    "invalid_access_token",
    /^(?:invalid (?:access|bearer|oauth) token|(?:access|bearer|oauth) token (?:is )?invalid)(?:[.:]|$)/,
  ],
  [
    "access_token_expired",
    /^(?:expired access token|access token (?:has |is )?expired)(?:[.:]|$)/,
  ],
  ["token_expired", /^expired token(?:[.:]|$)/],
  [
    "invalid_refresh_token",
    /^(?:invalid refresh token|refresh token (?:is )?invalid)(?:[.:]|$)/,
  ],
  [
    "missing_authorization",
    /^(?:missing authorization header|no authorization header|authorization header is missing|missing access token)(?:[.:]|$)/,
  ],
  ["invalid_client_secret", /^invalid client secret(?:[.:]|$)/],
  ["invalid_client", /^(?:invalid client|unknown client)(?:[.:]|$)/],
  [
    "invalid_api_key",
    /^(?:invalid api key(?: provided)?|no valid api key provided)(?:[.:]|$)/,
  ],
  [
    "insufficient_scope",
    /^(?:insufficient scope|missing required scopes?|access token is missing required scopes?|insufficient permissions)(?:[.:]|$)/,
  ],
  [
    "unauthorized",
    /^(?:unauthorized|not authenticated|authentication required)(?:[.:]|$)/,
  ],
  ["access_denied", /^(?:access denied|permission denied|forbidden)(?:[.:]|$)/],
] as const;

function providerMessageDiagnostic(
  body: unknown,
  request: LinkRequestDiagnostic,
  providerText?: string,
) {
  const parsed = providerMessageSchema.safeParse(body);
  const error = parsed.success ? parsed.data.error : undefined;
  const nested = object({
    message: zUnknown().optional(),
    detail: zUnknown().optional(),
  }).safeParse(error);
  const message = (value: unknown) => {
    return typeof value === "string" ? value : undefined;
  };
  const fields = [
    [
      "error.message",
      message(nested.success ? nested.data.message : undefined),
    ],
    ["message", message(parsed.success ? parsed.data.message : undefined)],
    [
      "error_description",
      message(parsed.success ? parsed.data.error_description : undefined),
    ],
    ["error.detail", message(nested.success ? nested.data.detail : undefined)],
    ["detail", message(parsed.success ? parsed.data.detail : undefined)],
    ["error", message(error)],
    ["response.text", providerText],
  ] as const;
  const field = fields.find(([, value]) => {
    return value !== undefined && value.trim().length > 0;
  });
  if (!field) {
    return {
      providerMessageSource: "unavailable",
      providerMessageReason: "unavailable",
      providerMessage: null,
    };
  }
  const normalized = field[1]?.trim().toLowerCase().replaceAll("_", " ");
  const reason = providerAuthMessageReasons.find(([, pattern]) => {
    return normalized !== undefined && pattern.test(normalized);
  })?.[0];
  return {
    providerMessageSource: field[0],
    providerMessageReason: reason ?? "unrecognized",
    providerMessage: safeProviderMessage(
      field[1] ?? "",
      request.sensitiveValues,
    ),
  };
}

function providerErrorCode(body: unknown, response: Response): string {
  const parsed = providerErrorSchema.safeParse(body);
  const error = parsed.success ? parsed.data.error : undefined;
  const candidate = typeof error === "string" ? error : error?.code;
  const code = providerErrorCodeSchema.safeParse(candidate);
  if (code.success) {
    return code.data;
  }
  const challenge = response.headers
    .get("www-authenticate")
    ?.match(/\berror="([a-z_]+)"/i)?.[1];
  const challengeCode = providerErrorCodeSchema.safeParse(challenge);
  if (challengeCode.success) {
    return challengeCode.data;
  }
  return candidate === undefined && challenge === undefined
    ? "unavailable"
    : "unrecognized";
}

const providerParameters: readonly string[] = Object.freeze([
  "amount",
  "currency",
  "merchant_name",
  "merchant_url",
  "context",
  "credential_type",
  "request_approval",
  "test",
  "expires_at",
  "totals",
  "line_items",
  "type",
  "display_text",
  "quantity",
  "unit_amount",
  "idempotency_key",
  "payment_method_id",
  "payment_details",
  "network_id",
  "merchant_account_id",
  "metadata",
  "recurring",
  "interval",
  "interval_count",
  "profile_id",
  "merchant_id",
  "client_id",
  "client_secret",
  "grant_type",
  "redirect_uri",
  "code",
  "code_verifier",
  "refresh_token",
  "token",
  "scope",
  "token_type_hint",
  "access_token",
  "expires_in",
  "token_type",
  "id",
  "status",
  "created_at",
  "updated_at",
  "approval_url",
  "approval_link",
  "status_details",
  "requires_action",
  "next_action",
  "resolution",
  "action_url",
  "error",
  "duplicate_spend_request",
  "card",
  "brand",
  "number",
  "cvc",
  "exp_month",
  "exp_year",
  "billing_address",
  "name",
  "line1",
  "line2",
  "city",
  "state",
  "postal_code",
  "country",
  "valid_until",
]);

function safeParameter(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 128) {
    return null;
  }
  const normalized = value.replaceAll(/\[\d+\]/g, ".[]");
  return normalized.split(".").every((part) => {
    return part === "[]" || providerParameters.includes(part);
  })
    ? normalized
    : null;
}

// Keep the provider's explanation, not its request/response payload. Redact
// request secrets first (including encoded echoes), then quoted values, contact
// details, payment numbers and opaque identifiers before bounding the output.
function safeProviderMessage(
  value: string,
  secrets: readonly string[],
): string {
  let message = value;
  for (const secret of secrets.filter(Boolean).sort((a, b) => {
    return b.length - a.length;
  })) {
    for (const encoded of new Set([
      secret,
      encodeURIComponent(Buffer.from(secret).toString("utf8")),
      Buffer.from(secret).toString("base64"),
    ])) {
      message = message.replaceAll(encoded, "[redacted]");
    }
  }
  return message
    .replace(/\bpayment_methods\.agentic\b/g, "payment methods agentic")
    .replace(/\buserinfo:read\b/g, "userinfo read")
    .replace(/https?:\/\/[^\s<>]+/gi, "[url]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/(["'`])([^"'`]*)\1/g, (_match, _quote: string, value: string) => {
      return safeParameter(value) ? `"${value}"` : "[redacted]";
    })
    .replace(/\b(?:bearer|basic)\s+\S+/gi, "[credential]")
    .replace(
      /\b(?:access[ _-]?token|refresh[ _-]?token|client[ _-]?secret|password|authorization|api[ _-]?key|cvc|cvv|pan|card[ _-]?number|billing[ _-]?address|email|phone)\s*[:=]\s*[^.;\n]+/gi,
      "[redacted]",
    )
    .replace(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g, "[redacted]")
    .replace(/\b[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)+\b/g, (word) => {
      return providerParameters.includes(word) ? word : "[redacted]";
    })
    .replace(/\b[A-Za-z0-9+/=]{32,}\b/g, "[redacted]")
    .replace(/\b[\w.-]+:[\w.-]+\b/g, "[redacted]")
    .replace(/\d(?:[\d .-]*\d)?/g, "[number]")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1024);
}

function responseMetadata(secrets: readonly string[], response?: Response) {
  const requestId = providerRequestIdSchema.safeParse(
    response?.headers.get("request-id") ??
      response?.headers.get("x-request-id"),
  );
  const contentType = zEnum([
    "application/json",
    "application/problem+json",
    "text/html",
    "text/plain",
  ]).safeParse(response?.headers.get("content-type")?.split(";")[0]?.trim());
  return {
    providerStatus: response?.status ?? null,
    providerRequestId:
      requestId.success &&
      !secrets.some((secret) => {
        return secret.length > 0 && requestId.data.includes(secret);
      })
        ? requestId.data
        : null,
    responseType: contentType.success ? contentType.data : "unrecognized",
  };
}

export function linkFailureDiagnostic(
  request: LinkRequestDiagnostic,
  details: {
    readonly stage:
      | "transport"
      | "http"
      | "response_body"
      | "response_schema"
      | "scope"
      | "action_url";
    readonly response?: Response;
    readonly body?: unknown;
    readonly providerText?: string;
    readonly responseBodyRead?: string;
    readonly issues?: readonly {
      readonly path: readonly PropertyKey[];
      readonly code: string;
    }[];
    readonly transportReason?: "timeout" | "network" | "cancelled";
    readonly transportError?: unknown;
    readonly scopes?: {
      paymentScopeGranted: boolean;
      userinfoScopeGranted: boolean;
    };
  },
) {
  const error = object({
    error: object({
      param: zUnknown().optional(),
      type: zUnknown().optional(),
    }),
  }).safeParse(details.body);
  const providerType = zEnum([
    "invalid_request_error",
    "authentication_error",
    "permission_error",
    "rate_limit_error",
    "api_error",
    "card_error",
  ]).safeParse(error.success ? error.data.error.type : undefined);
  const transportCode = zEnum([
    "ECONNREFUSED",
    "ECONNRESET",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_SOCKET",
    "CERT_HAS_EXPIRED",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
  ]);
  const transportError = object({
    name: zEnum([
      "Error",
      "TypeError",
      "AbortError",
      "TimeoutError",
    ]).optional(),
    code: transportCode.optional(),
    cause: object({ code: transportCode.optional() }).optional(),
  }).safeParse(details.transportError);
  const diagnostic = {
    diagnosticId: request.diagnosticId,
    operation: request.operation,
    intentId: request.intentId ?? null,
    failureStage: details.stage,
    requestSummary: request.requestSummary ?? null,
    durationMs: Math.round(monotonicNow() - request.startedAt),
    ...responseMetadata(request.sensitiveValues, details.response),
    providerErrorCode: details.response
      ? providerErrorCode(details.body, details.response)
      : "unavailable",
    providerErrorType: providerType.success ? providerType.data : null,
    providerErrorParam: safeParameter(
      error.success ? error.data.error.param : undefined,
    ),
    ...providerMessageDiagnostic(details.body, request, details.providerText),
    responseBodyRead: details.responseBodyRead ?? "not_read",
    transportReason: details.transportReason ?? null,
    transportErrorName: transportError.success
      ? (transportError.data.name ?? null)
      : null,
    transportErrorCode: transportError.success
      ? (transportError.data.cause?.code ?? transportError.data.code ?? null)
      : null,
    ...details.scopes,
    invalidFields:
      details.issues?.slice(0, 10).map((issue) => {
        const path = issue.path
          .map((part) => {
            return typeof part === "number" ? "[]" : String(part);
          })
          .join(".");
        return { field: safeParameter(path), issue: issue.code };
      }) ?? [],
  };
  L.warn("Link wallet provider request failed", diagnostic);
  return diagnostic;
}

export function linkSuccessDiagnostic(
  request: LinkRequestDiagnostic,
  response: Response,
  details: {
    paymentScopeGranted?: boolean;
    userinfoScopeGranted?: boolean;
  } = {},
) {
  L.debug("Link wallet provider request completed", {
    diagnosticId: request.diagnosticId,
    operation: request.operation,
    intentId: request.intentId ?? null,
    durationMs: Math.round(monotonicNow() - request.startedAt),
    ...responseMetadata(request.sensitiveValues, response),
    ...details,
  });
}

export function linkDiagnosticMessage(
  diagnostic: ReturnType<typeof linkFailureDiagnostic>,
): string {
  return `(operation: ${diagnostic.operation}; stage: ${diagnostic.failureStage}; HTTP ${diagnostic.providerStatus ?? "unavailable"}; provider: ${diagnostic.providerErrorCode}; message source: ${diagnostic.providerMessageSource}; reason: ${diagnostic.providerMessageReason}; parameter: ${diagnostic.providerErrorParam ?? "unavailable"}; body: ${diagnostic.responseBodyRead}; transport: ${diagnostic.transportReason ?? "none"}/${diagnostic.transportErrorCode ?? "unavailable"}; invalid fields: ${
    diagnostic.invalidFields
      .map((field) => {
        return `${field.field ?? "unrecognized"}:${field.issue}`;
      })
      .join(",") || "none"
  }; detail: ${diagnostic.providerMessage ?? "unavailable"}; reference: ${diagnostic.diagnosticId})`;
}
