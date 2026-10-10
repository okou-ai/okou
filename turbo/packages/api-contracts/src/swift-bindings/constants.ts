import {
  CLIENT_FORCE_UPGRADE_STATUS,
  CLIENT_REQUEST_ID_HEADER,
  CLIENT_SESSION_ID_HEADER,
  CLIENT_TYPE_DESKTOP,
  CLIENT_TYPE_HEADER,
  CLIENT_VERSION_HEADER,
} from "../contracts/client-headers";
import { DESKTOP_UPDATE_LINE_OKOU } from "../contracts/desktop-updates";
import { ApiError } from "../contracts/errors";

export interface SwiftConstantBinding {
  readonly swiftName: string;
  readonly value: string | number;
  readonly doc: readonly string[];
}

/**
 * Wire constants the Desktop app sends or compares. Rendered as static members
 * of `ApiConstants` in `desktop/Okou/Core/Generated/ApiConstants.swift`.
 */
export const swiftConstantBindings = [
  {
    swiftName: "clientVersionHeader",
    value: CLIENT_VERSION_HEADER,
    doc: ["Request header carrying the client's marketing version."],
  },
  {
    swiftName: "clientTypeHeader",
    value: CLIENT_TYPE_HEADER,
    doc: ["Request header naming the first-party client type."],
  },
  {
    swiftName: "clientSessionIdHeader",
    value: CLIENT_SESSION_ID_HEADER,
    doc: ["Request header carrying one identifier per client process."],
  },
  {
    swiftName: "clientRequestIdHeader",
    value: CLIENT_REQUEST_ID_HEADER,
    doc: ["Request header carrying one identifier per request."],
  },
  {
    swiftName: "clientTypeDesktop",
    value: CLIENT_TYPE_DESKTOP,
    doc: ["The `X-Client-Type` value the native Desktop app advertises."],
  },
  {
    swiftName: "clientForceUpgradeStatus",
    value: CLIENT_FORCE_UPGRADE_STATUS,
    doc: [
      "HTTP status the API answers when the client is below its version floor.",
    ],
  },
  {
    swiftName: "desktopUpdateLineOkou",
    value: DESKTOP_UPDATE_LINE_OKOU,
    doc: [
      "The `:product` segment of the Desktop update, release, and download routes.",
    ],
  },
  {
    swiftName: "apiErrorCodeConflict",
    value: ApiError.CONFLICT.code,
    doc: ["Error code of a `409` whose work was already recorded by the API."],
  },
] as const satisfies readonly SwiftConstantBinding[];
