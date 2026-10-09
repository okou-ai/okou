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

// Default Vitest file isolation gives this scenario a fresh module cache.
describe("desktop update routes", () => {
  it("redirects the final Okou line to final-identity release assets", async () => {
    mockDesktopUpdateManifest(
      stableManifest("1.2.3", {
        "1.2.3": darwinArm64Release("1.2.3", okouZipUrl("1.2.3")),
      }),
    );

    const releaseResponse = await appRequest(
      "http://api.test/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/release",
    );
    expect(releaseResponse.status).toBe(302);
    expect(releaseResponse.headers.get("Location")).toBe(
      "https://github.com/okou-ai/okou/releases/tag/okou-desktop-v1.2.3",
    );

    const dmgResponse = await appRequest(
      "http://api.test/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/dmg",
    );
    expect(dmgResponse.status).toBe(302);
    expect(dmgResponse.headers.get("Location")).toBe(
      "https://github.com/okou-ai/okou/releases/download/okou-desktop-v1.2.3/Okou-darwin-arm64-1.2.3.dmg",
    );
  });
});
