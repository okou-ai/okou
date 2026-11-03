export class ProviderHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = status;
  }
}

export function isProviderHttpError(
  value: unknown,
): value is ProviderHttpError {
  return value instanceof ProviderHttpError;
}

const RESPONSE_DIAGNOSTIC_FIELDS = Object.freeze([
  "access_token",
  "refresh_token",
  "expires_in",
  "open_id",
  "scope",
  "data",
  "data.user",
  "data.user.open_id",
  "data.user.display_name",
  "error",
  "error.code",
]);

const RESPONSE_DIAGNOSTIC_CODES = Object.freeze([
  "access_token_invalid",
  "invalid_token",
  "scope_not_authorized",
  "invalid_params",
  "rate_limit_exceeded",
  "internal_error",
  "scope_permission_missed",
]);

interface ProviderResponseDiagnostics {
  readonly stage: "token" | "profile";
  readonly reason:
    "invalid_json" | "invalid_schema" | "provider_error" | "identity_mismatch";
  readonly invalidFields?: readonly string[];
  readonly providerCode?: string;
  readonly httpStatus?: number;
  readonly contentType?: string | null;
}

function responseValueKind(value: unknown): string {
  return value === null
    ? "null"
    : Array.isArray(value)
      ? "array"
      : typeof value;
}

function responseShape(payload: unknown): string {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return responseValueKind(payload);
  }
  return (
    Object.entries(payload)
      .filter(([field]) => {
        return RESPONSE_DIAGNOSTIC_FIELDS.includes(field);
      })
      .map(([field, value]: [string, unknown]) => {
        return `${field}:${responseValueKind(value)}`;
      })
      .join(",") || "object"
  );
}

export class ProviderResponseError extends Error {
  readonly diagnostics:
    | (ProviderResponseDiagnostics & { readonly responseShape?: string })
    | undefined;

  constructor(
    message: string,
    diagnostics?: ProviderResponseDiagnostics,
    payload?: unknown,
  ) {
    super(message);
    this.name = "ProviderResponseError";
    if (diagnostics) {
      // Only schema field names and known codes may leave the response boundary.
      const invalidFields = diagnostics.invalidFields?.filter((field) => {
        return RESPONSE_DIAGNOSTIC_FIELDS.includes(field);
      });
      const contentType = diagnostics.contentType
        ?.split(";")[0]
        ?.trim()
        .toLowerCase();
      this.diagnostics = {
        stage: diagnostics.stage,
        reason: diagnostics.reason,
        ...(invalidFields?.length ? { invalidFields } : {}),
        ...(diagnostics.providerCode &&
        RESPONSE_DIAGNOSTIC_CODES.includes(diagnostics.providerCode)
          ? { providerCode: diagnostics.providerCode }
          : {}),
        ...(payload === undefined
          ? {}
          : { responseShape: responseShape(payload) }),
        ...(typeof diagnostics.httpStatus === "number" &&
        Number.isInteger(diagnostics.httpStatus) &&
        diagnostics.httpStatus >= 100 &&
        diagnostics.httpStatus <= 599
          ? { httpStatus: diagnostics.httpStatus }
          : {}),
        ...(contentType &&
        [
          "application/json",
          "application/problem+json",
          "text/html",
          "text/plain",
        ].includes(contentType)
          ? { contentType }
          : {}),
      };
    }
  }
}

export function isProviderResponseError(
  value: unknown,
): value is ProviderResponseError {
  return value instanceof ProviderResponseError;
}
