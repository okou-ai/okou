import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";

import { createDesktopUpdatePublicApi } from "./helpers/desktop-update-public";

const context = testContext();
const {
  appcastRequest,
  mockDesktopUpdateManifest,
  stableManifest,
  darwinArm64Release,
} = createDesktopUpdatePublicApi(context);

// Default Vitest file isolation gives this scenario a fresh module cache.
describe("desktop update routes", () => {
  it("does not serve a Zero artifact from the final Okou feed", async () => {
    mockDesktopUpdateManifest(
      stableManifest("1.2.3", {
        "1.2.3": darwinArm64Release(
          "1.2.3",
          "https://github.com/okou-ai/okou/releases/download/desktop-v1.2.3/Zero-darwin-arm64-1.2.3.zip",
        ),
      }),
    );

    const response = await appcastRequest();
    expect(response.status).toBe(404);

    await expect(response.json()).resolves.toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });
});
