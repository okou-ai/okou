import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";

import { mockNow, withMockNowForTest } from "../../../lib/time";

import { createDesktopUpdatePublicApi } from "./helpers/desktop-update-public";

const context = testContext();
const {
  client,
  mockDesktopUpdateManifest,
  stableManifest,
  darwinArm64Release,
  okouZipUrl,
} = createDesktopUpdatePublicApi(context);

// Default Vitest file isolation gives this scenario a fresh module cache.
describe("desktop update routes", () => {
  it("caches the desktop manifest until the 60-second ttl expires", async () => {
    const initialNow = Date.parse("2026-06-08T00:00:00.000Z");

    await withMockNowForTest(initialNow, async () => {
      mockDesktopUpdateManifest(
        stableManifest("0.2.1", {
          "0.2.1": darwinArm64Release("0.2.1", okouZipUrl("0.2.1")),
        }),
      );

      const firstResponse = await accept(
        client().productFeed({
          params: {
            product: "ai-okou-desktop",
            channel: "stable",
            platform: "darwin",
            arch: "arm64",
          },
        }),
        [200],
      );
      expect(firstResponse.body.currentRelease).toBe("0.2.1");

      mockDesktopUpdateManifest(
        stableManifest("0.2.2", {
          "0.2.2": darwinArm64Release("0.2.2", okouZipUrl("0.2.2")),
        }),
      );
      mockNow(initialNow + 59_999);

      const cachedResponse = await accept(
        client().productFeed({
          params: {
            product: "ai-okou-desktop",
            channel: "stable",
            platform: "darwin",
            arch: "arm64",
          },
        }),
        [200],
      );
      expect(cachedResponse.body.currentRelease).toBe("0.2.1");

      mockNow(initialNow + 60_000);

      const refreshedResponse = await accept(
        client().productFeed({
          params: {
            product: "ai-okou-desktop",
            channel: "stable",
            platform: "darwin",
            arch: "arm64",
          },
        }),
        [200],
      );
      expect(refreshedResponse.body.currentRelease).toBe("0.2.2");
    });
  });
});
