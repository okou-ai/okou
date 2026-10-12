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

describe("Native Desktop platform availability", () => {
  it("reports unavailable when Native platform assets are missing despite old manifest history", async () => {
    mockDesktopUpdateManifest(
      stableManifest("0.53.2", {
        "0.49.75": darwinArm64Release("0.49.75", okouZipUrl("0.49.75")),
        "0.53.1": {
          ...darwinArm64Release("0.53.1", okouZipUrl("0.53.1")),
          platforms: {},
        },
        "0.53.2": {
          ...darwinArm64Release("0.53.2", okouZipUrl("0.53.2")),
          platforms: {},
        },
      }),
    );
    for (const path of [
      "/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/appcast.xml",
      "/api/desktop/updates/stable/darwin/arm64/dmg",
      "/api/desktop/updates/stable/darwin/arm64/release",
    ]) {
      const response = await appRequest(path);
      expect(response.status).toBe(404);
    }
  });
});
