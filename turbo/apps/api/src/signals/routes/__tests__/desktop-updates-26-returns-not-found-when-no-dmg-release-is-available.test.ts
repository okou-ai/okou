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
  it("returns not found when no dmg release is available", async () => {
    mockDesktopUpdateManifest(
      stableManifest("0.11.2", {
        "0.11.2": darwinArm64Release("0.11.2", okouZipUrl("0.11.2")),
      }),
    );

    const response = await appRequest(
      "http://api.test/api/desktop/updates/stable/darwin/arm64/dmg",
    );

    expect(response.status).toBe(404);
  });
});
