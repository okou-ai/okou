import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";

import { createDesktopUpdatePublicApi } from "./helpers/desktop-update-public";

const context = testContext();
const {
  client,
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

    const response = await accept(
      client().productFeed({
        params: {
          product: "ai-okou-desktop",
          channel: "stable",
          platform: "darwin",
          arch: "arm64",
        },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});
