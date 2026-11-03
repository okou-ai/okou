import { BrowserBridgeError } from "@okouai/browser-extension-client";
import { i18n } from "../../../i18n/index.ts";
import { CdpFault } from "../cdp/errors.ts";
import type { ViewerError } from "./types.ts";

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
      message:
        error.code === -32_601
          ? i18n.t(($) => {
              return $.browserViewer.unsupportedCapability;
            })
          : error.message,
      ...(error.request ? { request: error.request } : {}),
      ...(error.cause instanceof BrowserBridgeError
        ? { bridge: error.cause.diagnostics }
        : {}),
    });
  }
  return Object.freeze({
    kind: "protocol",
    message: i18n.t(($) => {
      return $.browserViewer.operationFailed;
    }),
  });
}
