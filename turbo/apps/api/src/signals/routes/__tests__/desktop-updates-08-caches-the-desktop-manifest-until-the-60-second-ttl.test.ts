import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";

import { mockNow, withMockNowForTest } from "../../../lib/time";

import { createDesktopUpdatePublicApi } from "./helpers/desktop-update-public";

const context = testContext();
const {
  appcastRequest,
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

      const firstResponse = await appcastRequest();
      expect(firstResponse.status).toBe(200);
      expect(await firstResponse.text()).toContain(
        "<sparkle:version>0.2.1</sparkle:version>",
      );

      mockDesktopUpdateManifest(
        stableManifest("0.2.2", {
          "0.2.2": darwinArm64Release("0.2.2", okouZipUrl("0.2.2")),
        }),
      );
      mockNow(initialNow + 59_999);

      const cachedResponse = await appcastRequest();
      expect(cachedResponse.status).toBe(200);
      expect(await cachedResponse.text()).toContain(
        "<sparkle:version>0.2.1</sparkle:version>",
      );

      mockNow(initialNow + 60_000);

      const refreshedResponse = await appcastRequest();
      expect(refreshedResponse.status).toBe(200);
      expect(await refreshedResponse.text()).toContain(
        "<sparkle:version>0.2.2</sparkle:version>",
      );
    });
  });
});
