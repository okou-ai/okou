import {
  array,
  number,
  object,
  string,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { readBoundedResponseText, safeJsonParse } from "../utils";

const gmailErrorDetailSchema = object({
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
  "authError",
  "dailyLimitExceeded",
  "domainPolicy",
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "backendError",
  "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
]);

export class GmailAuthorizationError extends Error {
  constructor() {
    super("Gmail authorization is no longer valid");
    this.name = "GmailAuthorizationError";
  }
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

  // Provider messages, locations and even unknown reason tokens may contain
  // private values. Only known codes enter the normal error reporting path.
  const reasons = new Set(
    [...(error?.errors ?? []), ...(error?.details ?? [])].map((detail) => {
      const reason = gmailReasonSchema.safeParse(detail.reason);
      return reason.success ? reason.data : "unrecognized";
    }),
  );
  throw new Error(
    `Gmail rejected the draft send (HTTP ${response.status}; reason: ${
      reasons.size > 0 ? [...reasons].join(", ") : "unavailable"
    })`,
  );
}
