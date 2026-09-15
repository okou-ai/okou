import type { DesktopIdentityInfo } from "../desktop-bridge";

export function currentDesktopIdentity(): DesktopIdentityInfo {
  return window.okouDesktopIdentity;
}
