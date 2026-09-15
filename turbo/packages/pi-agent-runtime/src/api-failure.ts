import { classifyProviderFailure } from "@okouai/api-contracts/contracts/provider-failure";
import type { KnownRunFailureReason } from "@okouai/api-contracts/contracts/run-failure-reasons";

/** Content-free evidence; never infer an HTTP status from provider prose. */
export interface PiApiModelFailureDiagnostic {
  readonly category: "http_error" | "stream_terminated" | "aborted" | "unknown";
  readonly httpStatus?: number;
}

export function projectPiApiModelFailure(
  error: unknown,
  responseStatus?: number,
): PiApiModelFailureDiagnostic {
  const httpStatus =
    responseStatus !== undefined &&
    Number.isInteger(responseStatus) &&
    responseStatus >= 100 &&
    responseStatus <= 599
      ? responseStatus
      : undefined;
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : undefined;
  const category =
    httpStatus !== undefined && httpStatus >= 400
      ? "http_error"
      : message === "terminated"
        ? "stream_terminated"
        : error instanceof Error && error.name === "AbortError"
          ? "aborted"
          : "unknown";
  return { category, ...(httpStatus === undefined ? {} : { httpStatus }) };
}

/** Only the request/stream boundary may create this recovery provenance. */
export class PiApiModelRequestError extends Error {
  readonly diagnostic: PiApiModelFailureDiagnostic;
  readonly failureReason: KnownRunFailureReason | undefined;

  constructor(error: unknown, provider: string, responseStatus?: number) {
    super("Pi API model request failed");
    this.name = "PiApiModelRequestError";
    this.diagnostic = projectPiApiModelFailure(error, responseStatus);
    const reason = classifyPiApiProviderFailure(error, responseStatus);
    this.failureReason =
      reason === "reconnect_required" && provider !== "openai-codex"
        ? undefined
        : reason;
  }
}

/** Reduce a failed provider request to a content-free public reason. */
export function classifyPiApiProviderFailure(
  error: unknown,
  responseStatus?: number,
): KnownRunFailureReason | undefined {
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : undefined;
  return classifyProviderFailure(message ?? "", responseStatus);
}
