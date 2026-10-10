import { describe, expect, it } from "vitest";
import {
  desktopCompatibility,
  testContext,
} from "../../../__tests__/test-context";

import { createDesktopUpdatePublicApi } from "./helpers/desktop-update-public";

const context = testContext();
const {
  appRequest,
  mockDesktopUpdateManifest,
  stableManifest,
  darwinArm64Release,
  okouZipUrl,
} = createDesktopUpdatePublicApi(context);

// Default Vitest file isolation gives this scenario a fresh module cache.
describe("desktop update routes", () => {
  it("marks only supported Sparkle replacements critical and keeps the Electron feed accessible", async () => {
    desktopCompatibility.minimumSupportedVersion = "0.51.0";
    mockDesktopUpdateManifest(
      stableManifest("0.51.0", {
        "0.50.1": darwinArm64Release("0.50.1", okouZipUrl("0.50.1")),
        "0.51.0": darwinArm64Release("0.51.0", okouZipUrl("0.51.0")),
      }),
    );
    const path = "/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/";
    const native = await appRequest(`${path}appcast.xml`);
    expect(native.status).toBe(200);
    const items = (await native.text()).split("<item>").slice(1);
    const supported = items.find((item) => {
      return item.includes("<sparkle:version>0.51.0</sparkle:version>");
    });
    expect(supported).toContain(
      '<sparkle:criticalUpdate sparkle:version="0.51.0"/>',
    );
    for (const item of items.filter((item) => {
      return item.includes("<sparkle:version>0.50.1</sparkle:version>");
    })) {
      expect(item).not.toContain("criticalUpdate");
    }
    const legacy = await appRequest(`${path}RELEASES.json`);
    expect(legacy.status).toBe(200);
    await expect(legacy.json()).resolves.toMatchObject({
      currentRelease: "0.52.2",
    });
    const manual = await appRequest(`${path}dmg`);
    expect(manual.status).toBe(302);
    expect(manual.headers.get("location")).toBe(
      okouZipUrl("0.51.0").replace(".zip", ".dmg"),
    );
  });
});
