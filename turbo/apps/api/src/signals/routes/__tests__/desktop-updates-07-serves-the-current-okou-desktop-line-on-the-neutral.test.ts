import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";

import { createDesktopUpdatePublicApi } from "./helpers/desktop-update-public";

const context = testContext();
const {
  appRequest,
  mockDesktopUpdateManifest,
  stableManifest,
  darwinArm64Release,
  okouZipUrl,
  LEGACY_OKOU_DESKTOP_UPDATE_MANIFEST_URL,
} = createDesktopUpdatePublicApi(context);

// Default Vitest file isolation gives this scenario a fresh module cache.
describe("desktop update routes", () => {
  it("serves the current Okou desktop line on the neutral routes", async () => {
    mockDesktopUpdateManifest(
      stableManifest("0.12.0", {
        "0.12.0": darwinArm64Release("0.12.0", okouZipUrl("0.12.0")),
      }),
      LEGACY_OKOU_DESKTOP_UPDATE_MANIFEST_URL,
    );
    mockDesktopUpdateManifest(
      stableManifest("1.2.3", {
        "1.2.3": darwinArm64Release("1.2.3", okouZipUrl("1.2.3")),
      }),
    );

    const releaseResponse = await appRequest(
      "http://api.test/api/desktop/updates/stable/darwin/arm64/release",
    );

    expect(releaseResponse.status).toBe(302);
    expect(releaseResponse.headers.get("Location")).toBe(
      "https://github.com/okou-ai/okou/releases/tag/okou-desktop-v1.2.3",
    );
    expect(releaseResponse.headers.get("Cache-Control")).toBe("no-store");

    const dmgResponse = await appRequest(
      "http://api.test/api/desktop/updates/stable/darwin/arm64/dmg",
    );

    expect(dmgResponse.status).toBe(302);
    expect(dmgResponse.headers.get("Location")).toBe(
      "https://github.com/okou-ai/okou/releases/download/okou-desktop-v1.2.3/Okou-darwin-arm64-1.2.3.dmg",
    );
    expect(dmgResponse.headers.get("Cache-Control")).toBe("no-store");
  });
});
