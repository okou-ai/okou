import { describe, expect, it } from "vitest";
import {
  CLIENT_FORCE_UPGRADE_STATUS,
  CLIENT_HEADER_NAMES,
  CLIENT_REQUEST_ID_HEADER,
  CLIENT_SESSION_ID_HEADER,
  CLIENT_TYPE_APP,
  CLIENT_TYPE_CLI,
  CLIENT_TYPE_DESKTOP,
  CLIENT_TYPE_GUEST_AGENT,
  CLIENT_TYPE_HEADER,
  CLIENT_TYPE_MITM_ADDON,
  CLIENT_TYPE_RUNNER,
  CLIENT_VERSION_HEADER,
} from "./client-headers";

describe("client header contract", () => {
  it("documents the canonical X-Client-Type wire values", () => {
    expect({
      app: CLIENT_TYPE_APP,
      cli: CLIENT_TYPE_CLI,
      desktop: CLIENT_TYPE_DESKTOP,
      guestAgent: CLIENT_TYPE_GUEST_AGENT,
      mitmAddon: CLIENT_TYPE_MITM_ADDON,
      runner: CLIENT_TYPE_RUNNER,
    }).toStrictEqual({
      app: "App",
      cli: "CLI",
      desktop: "Desktop",
      guestAgent: "GuestAgent",
      mitmAddon: "MitmAddon",
      runner: "Runner",
    });
  });

  it("keeps client header names stable for CORS and request logs", () => {
    expect(CLIENT_HEADER_NAMES).toStrictEqual([
      CLIENT_VERSION_HEADER,
      CLIENT_TYPE_HEADER,
      CLIENT_SESSION_ID_HEADER,
      CLIENT_REQUEST_ID_HEADER,
    ]);
    expect(CLIENT_HEADER_NAMES).toStrictEqual([
      "X-Client-Version",
      "X-Client-Type",
      "X-Client-Session-Id",
      "X-Client-Request-Id",
    ]);
  });

  it("keeps the force upgrade status stable for app clients", () => {
    expect(CLIENT_FORCE_UPGRADE_STATUS).toBe(426);
  });
});
