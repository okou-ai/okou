import { CLIENT_FORCE_UPGRADE_STATUS } from "@okouai/api-contracts/contracts/client-headers";
import { isAbortError, onRejection } from "../signals/utils.ts";
import { ApiError } from "./api-error.ts";
import { isNetworkRequestError } from "./network-error.ts";

export const ACCEPT_ERROR_EVENT = "okou-accept-error";

export interface AcceptErrorEventDetail {
  readonly kind: "http-status" | "message" | "request-failed";
  readonly show: boolean;
  readonly code?: string;
  readonly status?: number;
  message?: string;
}

function presentAcceptError(detail: AcceptErrorEventDetail): void {
  globalThis.dispatchEvent(
    new CustomEvent<AcceptErrorEventDetail>(ACCEPT_ERROR_EVENT, { detail }),
  );
}

function extractError(
  body: unknown,
  status: number,
): Omit<AcceptErrorEventDetail, "show"> {
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
  const detail: AcceptErrorEventDetail =
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
  const detail: AcceptErrorEventDetail = {
    ...extracted,
    show:
      showErrorToast &&
      result.status !== 401 &&
      result.status !== CLIENT_FORCE_UPGRADE_STATUS &&
      (!expected || options.showExpectedErrorToast !== false),
  };
  presentAcceptError(detail);
  throw new ApiError(
    detail.message ?? `${Error.name}: ${result.status}`,
    code,
    result.status,
    expected,
  );
}

export { accept };
