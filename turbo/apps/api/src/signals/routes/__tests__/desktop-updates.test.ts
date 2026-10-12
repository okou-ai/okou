import { describe, expect, it } from "vitest";
import {
  desktopCompatibility,
  testContext,
} from "../../../__tests__/test-context";

import { createDesktopUpdatePublicApi } from "./helpers/desktop-update-public";

const context = testContext();
const { appRequest } = createDesktopUpdatePublicApi(context);
const shippedDesktopMinimumVersion =
  desktopCompatibility.minimumSupportedVersion;

// Default Vitest file isolation gives this scenario a fresh module cache.
describe("desktop update routes", () => {
  it("exposes the source-controlled floor without authentication and supports disabling it", async () => {
    desktopCompatibility.minimumSupportedVersion = shippedDesktopMinimumVersion;
    const shipped = await appRequest("/api/desktop/compatibility");
    expect(shipped.status).toBe(200);
    expect(shipped.headers.get("cache-control")).toBe("no-store");
    await expect(shipped.json()).resolves.toStrictEqual({
      minimumSupportedVersion: "0.51.0",
    });
    desktopCompatibility.minimumSupportedVersion = null;
    const disabled = await appRequest("/api/desktop/compatibility");
    expect(disabled.status).toBe(200);
    expect(disabled.headers.get("cache-control")).toBe("no-store");
    await expect(disabled.json()).resolves.toStrictEqual({
      minimumSupportedVersion: null,
    });
    desktopCompatibility.minimumSupportedVersion = "0.51.0";
    const enabled = await appRequest("/api/desktop/compatibility");
    await expect(enabled.json()).resolves.toStrictEqual({
      minimumSupportedVersion: "0.51.0",
    });
    desktopCompatibility.minimumSupportedVersion = null;
    const restored = await appRequest("/api/desktop/compatibility");
    await expect(restored.json()).resolves.toStrictEqual({
      minimumSupportedVersion: null,
    });
  });
});
