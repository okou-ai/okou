import {
  SOCIALKIT_TRANSCRIPT_ERROR_CODES,
  socialRetryAfterSecondsSchema,
  type SocialErrorReason,
} from "@okouai/api-contracts/contracts/social";

import { now } from "../../lib/time";

type ErrorStatus = 400 | 404 | 422 | 429 | 502 | 503;

interface ErrorDescription {
  readonly status: ErrorStatus;
  readonly code: string;
  readonly message: string;
  readonly reason: SocialErrorReason;
  readonly retryable: boolean;
}

const TRANSIENT_ERROR_CODES = [
  "upstream_login_required",
  "upstream_session_rejected",
  "upstream_unavailable",
  "upstream_invalid_response",
  "upstream_response_invalid",
  "upstream_timeout",
  "processing_timeout",
  "worker_storage_error",
  "worker_startup_error",
  "worker_runtime_error",
] as const;

function description(
  status: ErrorStatus,
  code: string,
  message: string,
  reason: SocialErrorReason,
  retryable = false,
): ErrorDescription {
  return { status, code, message, reason, retryable };
}

function codeDescription(
  code: string | undefined,
): ErrorDescription | undefined {
  const normalized = code?.toLowerCase();
  if (
    TRANSIENT_ERROR_CODES.some((candidate) => {
      return candidate === normalized;
    })
  ) {
    return description(
      502,
      "SOCIALKIT_UPSTREAM_ERROR",
      "The social data service could not complete extraction. A later bounded retry may help.",
      "upstream_failure",
      true,
    );
  }
  switch (normalized) {
    case "insufficient_credits": {
      return description(
        503,
        "SOCIALKIT_QUOTA_EXHAUSTED",
        "The social data service has insufficient provider credits. Try again after service capacity is restored.",
        "provider_quota_exhausted",
      );
    }
    case "content_restricted":
    case "file_too_large":
    case "duration_limit_exceeded":
    case "format_unavailable": {
      return description(
        422,
        "SOCIALKIT_CONTENT_RESTRICTED",
        "This content cannot be retrieved with the requested access or media constraints. Use eligible content.",
        "content_restricted",
      );
    }
    case "content_unavailable": {
      return description(
        404,
        "SOCIALKIT_CONTENT_UNAVAILABLE",
        "The requested social content is unavailable. Check its URL and accessibility.",
        "content_unavailable",
      );
    }
    case "no_transcript": {
      return description(
        404,
        "SOCIALKIT_NO_TRANSCRIPT",
        "No captions are available for this content. Do not automatically retry.",
        "no_transcript",
      );
    }
    case "transcript_not_ready": {
      return description(
        404,
        "SOCIALKIT_TRANSCRIPT_NOT_READY",
        "Captions are not ready. Stop immediate retries and check again later; captions may remain unavailable.",
        "transcript_not_ready",
      );
    }
    case "media_not_ready": {
      return description(
        422,
        "SOCIALKIT_MEDIA_NOT_READY",
        "This recording is not ready. Download the completed recording later.",
        "media_not_ready",
      );
    }
    case "upstream_rate_limited": {
      return description(
        503,
        "SOCIALKIT_RATE_LIMITED",
        "The source platform is temporarily rate limited. Retry later with bounded backoff.",
        "rate_limited",
        true,
      );
    }
    case "worker_dependency_error":
    case "media_processing_failed": {
      return description(
        502,
        "SOCIALKIT_UPSTREAM_ERROR",
        "The social data service could not process this media. Wait for a service fix before resubmitting.",
        "upstream_failure",
      );
    }
    default: {
      return undefined;
    }
  }
}

function legacyDescription(
  status: number,
  message: unknown,
  transcript: boolean,
  requireInstagramViews: boolean,
): ErrorDescription | undefined {
  // These unstructured responses remain part of the supported provider contract.
  const trimmedMessage =
    typeof message === "string" ? message.trim() : undefined;
  const legacyMessage =
    trimmedMessage && trimmedMessage.length <= 256
      ? trimmedMessage.toLowerCase()
      : undefined;
  if (
    status === 503 &&
    requireInstagramViews &&
    legacyMessage ===
      "instagram view count is temporarily unavailable. please retry."
  ) {
    return description(
      503,
      "SOCIALKIT_VIEWS_UNAVAILABLE",
      "Instagram view count is temporarily unavailable. No credits were charged. Retry later, or omit --require-views to use other available data.",
      "upstream_failure",
      true,
    );
  }
  if (transcript && status === 404) {
    return legacyMessage === "no transcript available for this video"
      ? description(
          404,
          SOCIALKIT_TRANSCRIPT_ERROR_CODES.TRANSCRIPT_UNAVAILABLE,
          "A transcript is not available for this video",
          "transcript_unavailable",
        )
      : description(
          404,
          SOCIALKIT_TRANSCRIPT_ERROR_CODES.AVAILABILITY_UNKNOWN,
          "SocialKit could not establish whether the source or transcript is unavailable",
          "availability_unknown",
        );
  }
  if (
    transcript &&
    status === 403 &&
    legacyMessage === "access denied - transcript may be disabled"
  ) {
    return description(
      502,
      SOCIALKIT_TRANSCRIPT_ERROR_CODES.ACCESS_DENIED,
      "SocialKit denied transcript access; transcript availability is unknown",
      "access_denied",
    );
  }
  if (status === 403) {
    if (legacyMessage === "invalid access key") {
      return description(
        502,
        "SOCIALKIT_AUTH_ERROR",
        "SocialKit provider authentication failed",
        "provider_authentication",
      );
    }
    if (legacyMessage === "request limit exceeded for this month") {
      return description(
        503,
        "SOCIALKIT_QUOTA_EXHAUSTED",
        "SocialKit provider quota is exhausted",
        "provider_quota_exhausted",
      );
    }
  }
  return undefined;
}

function statusDescription(
  status: number,
  message: unknown,
  transcript: boolean,
  requireInstagramViews: boolean,
): ErrorDescription {
  const legacy = legacyDescription(
    status,
    message,
    transcript,
    requireInstagramViews,
  );
  if (legacy) {
    return legacy;
  }
  switch (status) {
    case 400: {
      return description(
        400,
        "SOCIALKIT_INVALID_INPUT",
        "SocialKit rejected the request input",
        "invalid_input",
      );
    }
    case 401: {
      return description(
        502,
        "SOCIALKIT_AUTH_ERROR",
        "SocialKit provider authentication failed",
        "provider_authentication",
      );
    }
    case 403: {
      return description(
        502,
        "SOCIALKIT_UPSTREAM_ERROR",
        "SocialKit request failed",
        "upstream_failure",
      );
    }
    case 404: {
      return description(
        404,
        "SOCIALKIT_CONTENT_UNAVAILABLE",
        "The requested social content is unavailable",
        "content_unavailable",
      );
    }
    case 422: {
      return description(
        422,
        "SOCIALKIT_CONTENT_RESTRICTED",
        "This content cannot satisfy the requested media or access constraints",
        "content_restricted",
      );
    }
    case 429: {
      return description(
        429,
        "SOCIALKIT_RATE_LIMITED",
        "SocialKit is temporarily rate limited",
        "rate_limited",
        true,
      );
    }
    default: {
      return description(
        502,
        "SOCIALKIT_UPSTREAM_ERROR",
        "SocialKit request failed",
        "upstream_failure",
        status >= 500 && status <= 599,
      );
    }
  }
}

function safeCode(value: unknown, accessKey: string): string | undefined {
  return typeof value === "string" &&
    value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) &&
    !value.includes(accessKey)
    ? value
    : undefined;
}

function retryAfterSeconds(headers: Headers | undefined): number | undefined {
  const value = headers?.get("retry-after")?.trim();
  if (!value || value.length > 128) {
    return undefined;
  }
  // HTTP-date uses the IMF-fixdate wire format, not Date.parse's permissive numeric forms.
  const timestamp = Date.parse(value);
  const validHttpDate =
    Number.isFinite(timestamp) && new Date(timestamp).toUTCString() === value;
  const seconds = /^\d+$/u.test(value)
    ? Number(value)
    : validHttpDate
      ? Math.max(0, Math.ceil((timestamp - now()) / 1000))
      : undefined;
  const parsed = socialRetryAfterSecondsSchema.safeParse(seconds);
  return parsed.success ? parsed.data : undefined;
}

export function normalizeSocialKitError(
  status: number,
  body: unknown,
  options: {
    readonly accessKey: string;
    readonly headers?: Headers;
    readonly transcript?: boolean;
    readonly requireInstagramViews?: boolean;
  },
) {
  const record =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const errorCode = safeCode(record.errorCode, options.accessKey);
  const code = safeCode(record.code, options.accessKey);
  const explicitRetryable =
    typeof record.retryable === "boolean" ? record.retryable : undefined;
  const normalized =
    codeDescription(code) ??
    codeDescription(errorCode) ??
    statusDescription(
      status,
      record.message,
      options.transcript === true,
      options.requireInstagramViews === true,
    );
  const delay = retryAfterSeconds(options.headers);
  const { status: publicStatus, ...error } = normalized;
  return {
    status: publicStatus,
    error: {
      ...error,
      retryable: explicitRetryable ?? error.retryable,
      ...(delay === undefined ? {} : { retryAfterSeconds: delay }),
    },
    evidence: {
      httpStatus: status,
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(code === undefined ? {} : { code }),
      ...(explicitRetryable === undefined
        ? {}
        : { retryable: explicitRetryable }),
    },
  };
}
