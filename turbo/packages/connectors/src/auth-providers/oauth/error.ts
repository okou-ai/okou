import { ZodError } from "zod";

import {
  ProviderHttpError,
  isProviderHttpError,
  isProviderResponseError,
} from "../provider-error";

const MAX_DIAGNOSTIC_LENGTH = 500;

export class OAuthProviderHttpError extends ProviderHttpError {
  readonly oauthError: string | undefined;
  readonly oauthErrorSubtype: string | undefined;
  // Provider-specific code, independent of any OAuth error normalization.
  readonly providerErrorCode: string | undefined;

  constructor(
    message: string,
    status: number,
    oauthError: string | undefined = undefined,
    oauthErrorSubtype: string | undefined = undefined,
    providerErrorCode: string | undefined = undefined,
  ) {
    super(message, status);
    this.name = "OAuthProviderHttpError";
    this.oauthError = oauthError;
    this.oauthErrorSubtype = oauthErrorSubtype;
    this.providerErrorCode = providerErrorCode;
  }
}

export function isOAuthProviderHttpError(
  value: unknown,
): value is OAuthProviderHttpError {
  return value instanceof OAuthProviderHttpError;
}

/**
 * Read the response body from a failed OAuth request and throw an error
 * with diagnostic context (status code, error reason, description).
 *
 * Attempts to parse the body as JSON to extract standard OAuth error fields
 * (`error`, `error_description`) and provider-specific subtype details
 * (`error_subtype`). Falls back to raw text if not JSON.
 * Truncates long provider-controlled diagnostics to avoid noisy logs.
 */
export async function throwOAuthError(
  provider: string,
  operation: string,
  response: Response,
): Promise<never> {
  const status = response.status;
  let detail = "";
  let oauthError: string | undefined;
  let oauthErrorSubtype: string | undefined;

  const raw = await response.text();
  if (raw.length > 0) {
    try {
      const json: unknown = JSON.parse(raw);
      if (typeof json === "object" && json !== null) {
        const obj = json as Record<string, unknown>;
        const errorCode =
          typeof obj["error"] === "string" ? obj["error"] : null;
        const errorDesc =
          typeof obj["error_description"] === "string"
            ? obj["error_description"]
            : null;
        const errorSubtype =
          typeof obj["error_subtype"] === "string"
            ? obj["error_subtype"]
            : null;
        if (errorCode) {
          oauthError = errorCode;
          oauthErrorSubtype = errorSubtype ?? undefined;
          detail = oauthErrorDetail(errorCode, errorDesc);
        } else {
          detail = responseBodyDetail(raw);
        }
      } else {
        detail = responseBodyDetail(raw);
      }
    } catch {
      detail = responseBodyDetail(raw);
    }
  }

  throw new OAuthProviderHttpError(
    `${provider} token ${operation} failed: ${status}${detail}`,
    status,
    oauthError,
    oauthErrorSubtype,
  );
}

function oauthErrorDetail(
  errorCode: string,
  errorDescription: string | null,
): string {
  const code = truncatedDiagnostic(errorCode);
  return errorDescription
    ? ` ${code} (${truncatedDiagnostic(errorDescription)})`
    : ` ${code}`;
}

function responseBodyDetail(raw: string): string {
  return ` ${truncatedDiagnostic(raw)}`;
}

function truncatedDiagnostic(value: string): string {
  return value.length > MAX_DIAGNOSTIC_LENGTH
    ? `${value.slice(0, MAX_DIAGNOSTIC_LENGTH)}...`
    : value;
}

const STANDARD_OAUTH_ERRORS = Object.freeze([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "unsupported_response_type",
  "invalid_scope",
  "access_denied",
  "server_error",
  "temporarily_unavailable",
]);

export function standardOAuthErrorCode(value: unknown): string | undefined {
  return typeof value === "string" && STANDARD_OAUTH_ERRORS.includes(value)
    ? value
    : undefined;
}

function safeExceptionClass(error: unknown): string {
  for (const errorClass of [
    ZodError,
    TypeError,
    SyntaxError,
    RangeError,
    ReferenceError,
    URIError,
    EvalError,
    AggregateError,
    Error,
  ]) {
    if (error instanceof errorClass) {
      return errorClass.name;
    }
  }
  return "NonError";
}

// Never retain exception names, messages, stacks, or causes. Exception classes
// come from trusted constructors; cause inspection stops after one boundary.
export function oauthFailureDiagnostics(
  error: unknown,
): Readonly<Record<string, string | number>> {
  if (isOAuthProviderHttpError(error)) {
    const oauthError = standardOAuthErrorCode(error.oauthError);
    return {
      failureKind: "oauth_http",
      httpStatus: error.status,
      ...(oauthError ? { oauthError } : {}),
    };
  }
  if (isProviderHttpError(error)) {
    return { failureKind: "provider_http", httpStatus: error.status };
  }
  if (isProviderResponseError(error)) {
    const diagnostics = error.diagnostics;
    return {
      failureKind: "provider_response",
      ...(diagnostics
        ? {
            responseStage: diagnostics.stage,
            responseReason: diagnostics.reason,
            ...(diagnostics.httpStatus === undefined
              ? {}
              : { httpStatus: diagnostics.httpStatus }),
            ...(diagnostics.contentType
              ? { contentType: diagnostics.contentType }
              : {}),
            ...(diagnostics.invalidFields?.length
              ? { invalidFields: diagnostics.invalidFields.join(",") }
              : {}),
            ...(diagnostics.providerCode
              ? { providerCode: diagnostics.providerCode }
              : {}),
            ...(diagnostics.responseShape
              ? { responseShape: diagnostics.responseShape }
              : {}),
          }
        : {}),
    };
  }
  return {
    failureKind: "unexpected",
    exceptionClass: safeExceptionClass(error),
    ...(error instanceof Error && error.cause !== undefined
      ? { causeClass: safeExceptionClass(error.cause) }
      : {}),
  };
}
