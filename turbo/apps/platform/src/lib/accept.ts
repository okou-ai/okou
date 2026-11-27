import { CLIENT_FORCE_UPGRADE_STATUS } from "@okouai/api-contracts/contracts/client-headers";
import { CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES } from "@okouai/api-contracts/validators/custom-connectors";
import { toast } from "@okouai/ui/components/ui/sonner";

import { i18n } from "../i18n/index.ts";
import { isAbortError, onRejection } from "../signals/utils.ts";
import { ApiError } from "./api-error.ts";
import { isNetworkRequestError } from "./network-error.ts";
import { localizedSshError } from "./ssh-error.ts";
import { localizedVncError } from "./vnc-error.ts";

interface AcceptErrorDetail {
  readonly kind: "http-status" | "message" | "request-failed";
  readonly show: boolean;
  readonly code?: string;
  readonly status?: number;
  readonly message?: string;
}

function localizedAutomaticMcpOAuthError(code: string): string | undefined {
  switch (code) {
    case CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.AUTHENTICATION_RESPONSE_INVALID: {
      return i18n.t(($) => {
        return $.connectors.custom.connect.errors.authenticationResponseInvalid;
      });
    }
    case CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.DISCOVERY_INVALID: {
      return i18n.t(($) => {
        return $.connectors.custom.connect.errors.discoveryInvalid;
      });
    }
    case CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.AUTHORIZATION_UNSUPPORTED: {
      return i18n.t(($) => {
        return $.connectors.custom.connect.errors.authorizationUnsupported;
      });
    }
    case CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.CLIENT_REGISTRATION_UNAVAILABLE: {
      return i18n.t(($) => {
        return $.connectors.custom.connect.errors.clientRegistrationUnavailable;
      });
    }
    case CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.CLIENT_REGISTRATION_REJECTED: {
      return i18n.t(($) => {
        return $.connectors.custom.connect.errors.clientRegistrationRejected;
      });
    }
    case CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.CLIENT_REGISTRATION_INVALID: {
      return i18n.t(($) => {
        return $.connectors.custom.connect.errors.clientRegistrationInvalid;
      });
    }
    case CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.CLIENT_REGISTRATION_CONFLICT: {
      return i18n.t(($) => {
        return $.connectors.custom.connect.errors.clientRegistrationConflict;
      });
    }
    case CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.UNSAFE_URL: {
      return i18n.t(($) => {
        return $.connectors.custom.connect.errors.unsafeUrl;
      });
    }
    case CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.PROVIDER_UNAVAILABLE: {
      return i18n.t(($) => {
        return $.connectors.custom.connect.errors.providerUnavailable;
      });
    }
    case CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.BINDING_CHANGED: {
      return i18n.t(($) => {
        return $.connectors.custom.connect.errors.bindingChanged;
      });
    }
    default: {
      return undefined;
    }
  }
}

function presentAcceptError(detail: AcceptErrorDetail): string | undefined {
  let message = detail.message;
  if (detail.kind === "http-status") {
    message = i18n.t(
      ($) => {
        return $.global.errors.httpStatus;
      },
      { status: detail.status ?? 0 },
    );
  } else if (detail.kind === "request-failed") {
    message = i18n.t(($) => {
      return $.global.errors.requestFailed;
    });
  } else if (detail.code) {
    message =
      localizedSshError(detail.code) ??
      localizedVncError(detail.code) ??
      localizedAutomaticMcpOAuthError(detail.code) ??
      message;
  }
  if (detail.show && message) {
    toast.error(message);
  }
  return message;
}

function extractError(
  body: unknown,
  status: number,
): Omit<AcceptErrorDetail, "show"> {
  if (
    body !== null &&
    typeof body === "object" &&
    "error" in body &&
    body.error !== null &&
    typeof body.error === "object" &&
    "message" in body.error &&
    typeof body.error.message === "string" &&
    body.error.message.trim().length > 0
  ) {
    const code =
      "code" in body.error && typeof body.error.code === "string"
        ? body.error.code
        : "UNKNOWN";
    return {
      kind: "message",
      code,
      message: body.error.message,
    };
  }
  return {
    kind: "http-status",
    status,
  };
}

function presentRequestError(error: unknown): void {
  const detail: AcceptErrorDetail =
    error instanceof Error
      ? { kind: "message", message: error.message, show: true }
      : { kind: "request-failed", show: true };
  presentAcceptError(detail);
}

interface AcceptOptions {
  readonly showErrorToast?: boolean;
  readonly showExpectedErrorToast?: boolean;
  readonly expectedErrors?: Readonly<
    Partial<Record<number, readonly string[]>>
  >;
}

/**
 * Awaits a typed API response and returns it if the status code is in `codes`.
 * Otherwise throws an `ApiError` and, by default, shows a toast. A 401
 * propagates without a toast or request replay. A force-upgrade response is
 * presented by the blocking update dialog instead of a toast.
 *
 * Browser network failures propagate without showing their raw error message.
 *
 * When `signal` is provided, a rejection after that signal aborts propagates
 * as cancellation without showing a toast.
 *
 * Best-effort background work may disable the error toast while preserving the
 * same typed response handling and thrown error.
 *
 * Callers may declare expected status/code pairs. They throw an ApiError,
 * but detached work does not log them as errors. Forms that render these
 * errors inline may disable their toast without hiding unrelated failures.
 */
async function accept<
  T extends { status: number; body: unknown },
  S extends number,
>(
  promise: Promise<T>,
  codes: S[],
  signal?: AbortSignal,
  options: AcceptOptions = {},
): Promise<Extract<T, { status: S }>> {
  const showErrorToast = options.showErrorToast ?? true;
  // eslint-disable-next-line ccstate/no-on-rejection -- 存量 2026/10/21: shared request-error presentation boundary.
  const result = await onRejection(promise, (error) => {
    if (!isAbortError(error)) {
      signal?.throwIfAborted();
      if (showErrorToast && !isNetworkRequestError(error)) {
        presentRequestError(error);
      }
    }
  });
  if ((codes as number[]).includes(result.status)) {
    return result as Extract<T, { status: S }>;
  }
  const extracted = extractError(result.body, result.status);
  const code = extracted.code ?? "UNKNOWN";
  const expected =
    options.expectedErrors?.[result.status]?.includes(code) ?? false;
  const message = presentAcceptError({
    ...extracted,
    show:
      showErrorToast &&
      result.status !== 401 &&
      result.status !== CLIENT_FORCE_UPGRADE_STATUS &&
      (!expected || options.showExpectedErrorToast !== false),
  });
  throw new ApiError(
    message ?? `${Error.name}: ${result.status}`,
    code,
    result.status,
    expected,
  );
}

export { accept };
