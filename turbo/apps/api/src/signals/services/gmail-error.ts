import {
  array,
  number,
  object,
  string,
  enum as zEnum,
  type infer as zInfer,
  unknown as zUnknown,
} from "zod";

import { readBoundedResponseText, safeJsonParse } from "../utils";

const gmailErrorDetailTypeSchema = zEnum([
  "type.googleapis.com/google.rpc.BadRequest",
  "type.googleapis.com/google.rpc.ErrorInfo",
  "type.googleapis.com/google.rpc.PreconditionFailure",
  "type.googleapis.com/google.rpc.QuotaFailure",
]);
const gmailErrorDetailSchema = object({
  "@type": zUnknown().optional(),
  domain: string().optional(),
  reason: string().optional(),
  location: string().optional(),
  locationType: string().optional(),
});
const gmailErrorResponseSchema = object({
  error: object({
    code: number().optional(),
    status: string().optional(),
    errors: array(gmailErrorDetailSchema).optional(),
    details: array(gmailErrorDetailSchema).optional(),
  }),
});
type GmailError = zInfer<typeof gmailErrorResponseSchema>["error"];
const gmailReconnectResponseSchema = object({
  error: object({
    details: array(
      object({
        domain: string().optional(),
        reason: string().optional(),
      }),
    ).optional(),
  }),
});

const gmailReasonSchema = zEnum([
  "badRequest",
  "failedPrecondition",
  "invalid",
  "required",
  "authError",
  "forbidden",
  "insufficientPermissions",
  "dailyLimitExceeded",
  "domainPolicy",
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "backendError",
  "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
]);

const gmailErrorStatusSchema = zEnum([
  "INVALID_ARGUMENT",
  "FAILED_PRECONDITION",
  "NOT_FOUND",
  "UNAUTHENTICATED",
  "PERMISSION_DENIED",
  "RESOURCE_EXHAUSTED",
  "INTERNAL",
  "UNAVAILABLE",
]);

export class GmailAuthorizationError extends Error {
  constructor() {
    super("Gmail authorization is no longer valid");
    this.name = "GmailAuthorizationError";
  }
}

type GmailHistoryReadFailure =
  | { readonly kind: "stale_cursor" }
  | { readonly kind: "retryable_error" }
  | { readonly kind: "gmail_error"; readonly status: number };

export function classifyGmailHistoryReadError(
  status: number,
  body: string,
): GmailHistoryReadFailure {
  if (status === 404) {
    return { kind: "stale_cursor" };
  }
  if (
    status === 0 ||
    status === 408 ||
    status === 429 ||
    (status >= 500 && status < 600)
  ) {
    return { kind: "retryable_error" };
  }
  if (status === 403) {
    const parsed = gmailErrorResponseSchema.safeParse(safeJsonParse(body));
    if (
      parsed.success &&
      [
        ...(parsed.data.error.errors ?? []),
        ...(parsed.data.error.details ?? []),
      ].some((detail) => {
        return (
          detail.reason === "rateLimitExceeded" ||
          detail.reason === "userRateLimitExceeded"
        );
      })
    ) {
      return { kind: "retryable_error" };
    }
  }
  return { kind: "gmail_error", status };
}

async function readGmailErrorBody(response: Response): Promise<unknown> {
  const body = await readBoundedResponseText(response, 16 * 1024);
  if (body.kind === "too_large") {
    return null;
  }
  return safeJsonParse(body.text);
}

function requiresReconnect(status: number, body: unknown): boolean {
  if (status === 401) {
    return true;
  }
  if (status !== 403) {
    return false;
  }
  const parsed = gmailReconnectResponseSchema.safeParse(body);
  return (
    parsed.success &&
    parsed.data.error.details?.some((detail) => {
      return (
        detail.domain === "googleapis.com" &&
        detail.reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT"
      );
    }) === true
  );
}

export async function gmailResponseRequiresReconnect(
  response: Response,
): Promise<boolean> {
  return requiresReconnect(
    response.status,
    response.status === 403 ? await readGmailErrorBody(response) : null,
  );
}

function isDraftRejection(error: GmailError | null): boolean {
  return (
    error !== null &&
    (error.code === undefined || error.code === 400) &&
    (error.status === undefined || error.status === "INVALID_ARGUMENT") &&
    (error.details === undefined || error.details.length === 0) &&
    error.errors !== undefined &&
    error.errors.length > 0 &&
    error.errors.every((detail) => {
      return (
        detail.domain === "global" &&
        detail.reason === "badRequest" &&
        detail.location === undefined &&
        detail.locationType === undefined
      );
    })
  );
}

export interface GmailDraftRejection {
  readonly kind: "rejected";
  readonly message: string;
}

export async function handleGmailSendError(
  response: Response,
): Promise<GmailDraftRejection> {
  // A 401 is authoritative even if the error body is absent or unreadable.
  const body =
    response.status === 401 ? null : await readGmailErrorBody(response);
  if (requiresReconnect(response.status, body)) {
    throw new GmailAuthorizationError();
  }
  const parsed = gmailErrorResponseSchema.safeParse(body);
  const error = parsed.success ? parsed.data.error : null;
  if (response.status === 400 && isDraftRejection(error)) {
    return {
      kind: "rejected",
      message:
        "Gmail rejected this draft. Open it in Gmail and check its recipients and content before trying again.",
    };
  }

  // Only allowlisted upstream values are safe to add to the request error log.
  const reasons = new Set(
    [...(error?.errors ?? []), ...(error?.details ?? [])].map((detail) => {
      if (!detail.reason) {
        return "missing";
      }
      const reason = gmailReasonSchema.safeParse(detail.reason);
      return reason.success ? reason.data : "unrecognized";
    }),
  );
  const providerReasons =
    reasons.size > 0 ? [...reasons] : [error ? "missing" : "unavailable"];
  const providerErrorCode = gmailErrorStatusSchema.safeParse(error?.status);
  const providerDetailTypes = [
    ...new Set(
      (error?.details ?? []).flatMap((detail) => {
        const type = gmailErrorDetailTypeSchema.safeParse(detail["@type"]);
        return type.success ? [type.data] : [];
      }),
    ),
  ];
  throw Object.assign(
    new Error(
      `Gmail rejected the draft send (HTTP ${response.status}; reason: ${providerReasons.join(", ")})`,
    ),
    {
      providerStatus: response.status,
      providerReasons,
      ...(providerErrorCode.success
        ? { providerErrorCode: providerErrorCode.data }
        : {}),
      ...(providerDetailTypes.length > 0 ? { providerDetailTypes } : {}),
    },
  );
}
