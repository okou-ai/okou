import { CHAT_EVENT_SCHEMA_VERSION_HEADER } from "./chat-event-schema-version";

export const CLIENT_VERSION_HEADER = "X-Client-Version";
export const CLIENT_TYPE_HEADER = "X-Client-Type";
export const CLIENT_PRODUCT_HEADER = "X-Client-Product";
export const CLIENT_SESSION_ID_HEADER = "X-Client-Session-Id";
export const CLIENT_REQUEST_ID_HEADER = "X-Client-Request-Id";
export { CHAT_EVENT_SCHEMA_VERSION_HEADER } from "./chat-event-schema-version";
export const CLIENT_FORCE_UPGRADE_STATUS = 426;

// Canonical X-Client-Type wire values emitted by first-party clients.
export const CLIENT_TYPE_APP = "App";
export const CLIENT_TYPE_CLI = "CLI";
export const CLIENT_TYPE_DESKTOP = "Desktop";
export const CLIENT_TYPE_GUEST_AGENT = "GuestAgent";
export const CLIENT_TYPE_MITM_ADDON = "MitmAddon";
export const CLIENT_TYPE_RUNNER = "Runner";

export const DESKTOP_PRODUCT_ZERO = "zero";
export const DESKTOP_PRODUCT_OKOU = "okou";
export const DESKTOP_PRODUCTS = [
  DESKTOP_PRODUCT_ZERO,
  DESKTOP_PRODUCT_OKOU,
] as const;
export type DesktopProduct = (typeof DESKTOP_PRODUCTS)[number];

export function desktopProductFromClientHeader(
  value: string | null | undefined,
): DesktopProduct | undefined {
  if (value === DESKTOP_PRODUCT_ZERO || value === DESKTOP_PRODUCT_OKOU) {
    return value;
  }
  return undefined;
}

export const CLIENT_HEADER_NAMES = [
  CLIENT_VERSION_HEADER,
  CLIENT_TYPE_HEADER,
  CLIENT_PRODUCT_HEADER,
  CLIENT_SESSION_ID_HEADER,
  CLIENT_REQUEST_ID_HEADER,
  CHAT_EVENT_SCHEMA_VERSION_HEADER,
] as const;
