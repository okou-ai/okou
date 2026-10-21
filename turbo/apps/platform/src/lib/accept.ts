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
  show: boolean,
): { message: string; code: string } {
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
    const detail: AcceptErrorEventDetail = {
      kind: "message",
      code,
      message: body.error.message,
      show,
    };
    presentAcceptError(detail);
    return { message: detail.message ?? body.error.message, code };
  }
  const detail: AcceptErrorEventDetail = {
    kind: "http-status",
    show,
    status,
  };
  presentAcceptError(detail);
  return {
    message: detail.message ?? `${Error.name}: ${status}`,
    code: "UNKNOWN",
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
  readonly expectedErrors?: Readonly<
    Partial<Record<number, readonly string[]>>
  >;
}

/**
 * Awaits a typed API response and returns it if the status code is in `codes`.
 * Otherwise throws an `ApiError` and, by default, shows a toast. A 401 is
 * never toasted because the authenticated clients own sign-in recovery. A
 * force-upgrade response is never toasted because the blocking dialog owns
 * recovery.
 *
 * Browser network failures propagate without showing their raw error message.
 *
 * When `signal` is provided, a rejection after that signal aborts propagates
 * as cancellation without showing a toast.
 *
 * Best-effort background work may disable the error toast while preserving the
 * same typed response handling and thrown error.
 *
 * Callers may declare expected status/code pairs. They still show the same
 * toast and throw an ApiError, but detached work does not log them as errors.
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
  const show =
    showErrorToast &&
    result.status !== 401 &&
    result.status !== CLIENT_FORCE_UPGRADE_STATUS;
  const { message, code } = extractError(result.body, result.status, show);
  const expected =
    options.expectedErrors?.[result.status]?.includes(code) ?? false;
  throw new ApiError(message, code, result.status, expected);
}

export { accept };
