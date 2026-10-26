import { accept, HttpStatusError } from "@okouai/connectors/accept";
import { settle } from "../utils";

const TELEGRAM_OAUTH_BASE_URL = "https://oauth.telegram.org/auth";

interface TelegramDomainCheckResult {
  readonly configured: boolean;
  readonly reason:
    | "verified"
    | "missing_content_length"
    | "invalid_content_length"
    | "short_response"
    | "request_failed";
  readonly httpStatus: number | null;
  readonly contentLength: number | null;
  readonly durationMs: number;
  readonly errorType?: "TypeError" | "Error" | "unknown";
}

export async function checkTelegramDomain(
  telegramBotId: string,
  appUrl: string,
): Promise<TelegramDomainCheckResult> {
  const query = new URLSearchParams({
    bot_id: telegramBotId,
    origin: appUrl,
  });
  const startedAt = performance.now();
  const result = await settle(
    accept(
      fetch(`${TELEGRAM_OAUTH_BASE_URL}?${query}`, {
        method: "HEAD",
      }),
      [200],
    ),
  );
  const durationMs = Math.round(performance.now() - startedAt);
  if (!result.ok) {
    const error = result.error;
    const errorType =
      error instanceof TypeError
        ? "TypeError"
        : error instanceof Error
          ? "Error"
          : "unknown";
    return {
      configured: false,
      reason: "request_failed",
      httpStatus: error instanceof HttpStatusError ? error.status : null,
      contentLength: null,
      durationMs,
      errorType,
    };
  }

  const response = result.value;
  const contentLength = response.headers.get("content-length");
  const length = contentLength === null ? null : Number(contentLength);
  // Preserve the existing readiness gate. A short/missing response only means
  // this heuristic could not verify the domain; it does not prove misconfiguration.
  const configured = length !== null && length > 1000;
  return {
    configured,
    reason: configured
      ? "verified"
      : length === null
        ? "missing_content_length"
        : !Number.isFinite(length)
          ? "invalid_content_length"
          : "short_response",
    httpStatus: response.status,
    contentLength: length !== null && Number.isFinite(length) ? length : null,
    durationMs,
  };
}
