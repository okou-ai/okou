function httpError<STATUS extends number, CODE extends string>(
  status: STATUS,
  code: CODE,
  message: string,
) {
  return Object.freeze({
    status,
    body: {
      error: {
        message,
        code,
      },
    },
  });
}

export function notFound(message: string) {
  return httpError(404, "NOT_FOUND", message);
}

export function conflict(message: string) {
  return httpError(409, "CONFLICT", message);
}

export const AUTONOMY_BUDGET_EXHAUSTED_MESSAGE =
  "Maximum autonomous delegation depth reached. Send a new human message or confirm a permission request to continue.";

export function autonomyBudgetExhausted() {
  return httpError(
    409,
    "AUTONOMY_BUDGET_EXHAUSTED",
    AUTONOMY_BUDGET_EXHAUSTED_MESSAGE,
  );
}

export function runNotCancellable(message: string) {
  return httpError(400, "RUN_NOT_CANCELLABLE", message);
}

export function providerUnavailable(message: string) {
  return httpError(503, "PROVIDER_UNAVAILABLE", message);
}

export function billingCheckoutDirectoryRateLimited() {
  return httpError(
    503,
    "BILLING_CHECKOUT_DIRECTORY_RATE_LIMITED",
    "Billing organization members are temporarily unavailable",
  );
}

export function modelProviderUnavailable(message: string) {
  return httpError(503, "MODEL_PROVIDER_UNAVAILABLE", message);
}

export function notConfigured(message: string) {
  return httpError(503, "NOT_CONFIGURED", message);
}

export function eventDeliveryUnavailable(message: string) {
  return httpError(503, "EVENT_DELIVERY_UNAVAILABLE", message);
}

export function desktopUpdateUnavailable(message: string) {
  return httpError(503, "DESKTOP_UPDATE_UNAVAILABLE", message);
}

export function insufficientCredits() {
  return httpError(
    402,
    "INSUFFICIENT_CREDITS",
    "Insufficient credits. Add credits or configure your own API key to continue.",
  );
}

export function teamRequired(message: string) {
  return httpError(402, "TEAM_REQUIRED", message);
}

export function badRequestMessage(message: string) {
  return httpError(400, "BAD_REQUEST", message);
}

interface ZodLikeIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

export function badRequest(issue: ZodLikeIssue) {
  const path = issue.path.map(String).join(".");
  const message = path ? `${path}: ${issue.message}` : issue.message;
  return httpError(400, "BAD_REQUEST", message);
}

type HttpResponseLike<S extends number> = {
  readonly status: S;
  readonly body: unknown;
};

function isHttpResponse<S extends number>(
  value: unknown,
  status: S,
): value is HttpResponseLike<S> {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    (value as { status: unknown }).status === status
  );
}

export function isBadRequestResponse(
  value: unknown,
): value is HttpResponseLike<400> {
  return isHttpResponse(value, 400);
}

export function isNotFoundResponse(
  value: unknown,
): value is HttpResponseLike<404> {
  return isHttpResponse(value, 404);
}
