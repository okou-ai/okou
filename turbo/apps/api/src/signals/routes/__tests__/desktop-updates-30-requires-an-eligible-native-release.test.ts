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
} = createDesktopUpdatePublicApi(context);

describe("Native Desktop update availability", () => {
  it("reports unavailable when every Native candidate is blocked and keeps the fixed migration hop", async () => {
    mockDesktopUpdateManifest(
      stableManifest(
        "0.53.2",
        {
          "0.49.75": darwinArm64Release("0.49.75", okouZipUrl("0.49.75")),
          "0.50.0": darwinArm64Release("0.50.0", okouZipUrl("0.50.0")),
          "0.53.2": darwinArm64Release("0.53.2", okouZipUrl("0.53.2")),
          "0.53.3": darwinArm64Release("0.53.3", okouZipUrl("0.53.3")),
        },
        ["0.50.0", "0.53.2"],
      ),
    );
    for (const path of [
      "/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/appcast.xml",
      "/api/desktop/updates/stable/darwin/arm64/dmg",
      "/api/desktop/updates/stable/darwin/arm64/release",
    ]) {
      const response = await appRequest(path);
      expect(response.status).toBe(404);
    }
    const hop = await appRequest(
      "/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/RELEASES.json",
    );
    expect(hop.status).toBe(200);
    await expect(hop.json()).resolves.toMatchObject({
      currentRelease: "0.52.2",
    });
  });
});
