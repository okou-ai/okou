import { describe, expect, it } from "vitest";
import {
  CLIENT_FORCE_UPGRADE_STATUS,
  CLIENT_HEADER_NAMES,
  CLIENT_PRODUCT_HEADER,
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
  CHAT_EVENT_SCHEMA_VERSION_HEADER,
  DESKTOP_PRODUCT_OKOU,
  DESKTOP_PRODUCT_ZERO,
  desktopProductFromClientHeader,
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
      CLIENT_PRODUCT_HEADER,
      CLIENT_SESSION_ID_HEADER,
      CLIENT_REQUEST_ID_HEADER,
      CHAT_EVENT_SCHEMA_VERSION_HEADER,
    ]);
    expect(CLIENT_HEADER_NAMES).toStrictEqual([
      "X-Client-Version",
      "X-Client-Type",
      "X-Client-Product",
      "X-Client-Session-Id",
      "X-Client-Request-Id",
      "X-Chat-Event-Schema-Version",
    ]);
  });

  it.each([DESKTOP_PRODUCT_ZERO, DESKTOP_PRODUCT_OKOU])(
    "recognizes explicit desktop product %s",
    (product) => {
      expect(desktopProductFromClientHeader(product)).toBe(product);
    },
  );

  it.each([
    undefined,
    null,
    "",
    "unknown",
    "Okou",
    "ZERO",
    " okou ",
    "zero,okou",
  ])(
    "leaves missing or unrecognized desktop product %s unclassified",
    (product) => {
      expect(desktopProductFromClientHeader(product)).toBeUndefined();
    },
  );

  it("keeps the force upgrade status stable for app clients", () => {
    expect(CLIENT_FORCE_UPGRADE_STATUS).toBe(426);
  });
});
