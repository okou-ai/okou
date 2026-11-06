import { BrowserBridgeError } from "@okouai/browser-extension-client";
import { i18n } from "../../../i18n/index.ts";
import { CdpFault } from "../cdp/errors.ts";
import type { ViewerError } from "./types.ts";
import { ApiError } from "../../../lib/api-error.ts";
import { isNetworkRequestError } from "../../../lib/network-error.ts";

/** Resource recovery is allowed only for classified failures, never arbitrary effects. */
function transientFailure(error: unknown): boolean {
  if (isNetworkRequestError(error)) {
    return true;
  }
  if (error instanceof ApiError) {
    return error.status === 429 || (error.status >= 500 && error.status < 600);
  }
  if (!(error instanceof CdpFault) || error.code === -32_601) {
    return false;
  }
  if (error.kind === "connection" || error.kind === "frame") {
    return true;
  }
  if (error.readOnly || isImageFailure(error)) {
    return true;
  }
  return (
    error.kind === "extension" &&
    error.cause instanceof BrowserBridgeError &&
    [
      "cdp-connection-failed",
      "worker-unobserved",
      "worker-readiness-timeout",
      "closed",
      "browser-session-detached",
      "worker-crashed",
      "worker-detached",
      "worker-context-cleared",
      "worker-target-destroyed",
      "worker-session-detached",
      "worker-target-replaced",
      "epoch-changed",
      "sequence-gap",
      "response-sequence-ahead",
    ].includes(error.cause.diagnostics.reason)
  );
}

export function isImageFailure(error: ViewerError): boolean {
  return (
    error.kind === "frame" ||
    (error.kind === "protocol" &&
      (error.request?.method === "Page.startScreencast" ||
        error.request?.method === "Page.stopScreencast"))
  );
}

export function diagnostic(error: unknown): ViewerError {
  if (error instanceof CdpFault) {
    return Object.freeze({
      kind: error.code === -32_601 ? "unsupported-capability" : error.kind,
      transient: transientFailure(error),
      message:
        error.code === -32_601
          ? i18n.t(($) => {
              return $.browserViewer.unsupportedCapability;
            })
          : error.message,
      ...(error.request ? { request: error.request } : {}),
      ...(error.connection ? { connection: error.connection } : {}),
      ...(error.window ? { window: error.window } : {}),
      ...(error.cause instanceof BrowserBridgeError
        ? { bridge: error.cause.diagnostics }
        : {}),
    });
  }
  return Object.freeze({
    kind: "protocol",
    transient: transientFailure(error),
    ...(error instanceof ApiError
      ? { http: { status: error.status, code: error.code } }
      : {}),
    message: i18n.t(($) => {
      return $.browserViewer.operationFailed;
    }),
  });
}
