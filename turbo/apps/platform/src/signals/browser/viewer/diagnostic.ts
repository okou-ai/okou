import { i18n } from "../../../i18n/index.ts";
import { CdpFault } from "../cdp/errors.ts";
import type { ViewerError } from "./types.ts";

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
    });
  }
  return Object.freeze({
    kind: "protocol",
    message: i18n.t(($) => {
      return $.browserViewer.operationFailed;
    }),
  });
}
