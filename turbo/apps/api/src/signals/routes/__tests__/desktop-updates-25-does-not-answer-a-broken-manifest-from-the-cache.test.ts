import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";

import { mockNow, withMockNowForTest } from "../../../lib/time";

import { createDesktopUpdatePublicApi } from "./helpers/desktop-update-public";

const context = testContext();
const {
  appRequest,
  mockDesktopUpdateManifest,
  stableManifest,
  darwinArm64Release,
  okouZipUrl,
  appcastRequest,
  countingManifestHandler,
} = createDesktopUpdatePublicApi(context);

// Default Vitest file isolation gives this scenario a fresh module cache.
describe("desktop update routes", () => {
  it("does not answer a broken manifest from the cache", async () => {
    const initialNow = Date.parse("2026-06-08T00:00:00.000Z");

    await withMockNowForTest(initialNow, async () => {
      mockDesktopUpdateManifest(
        stableManifest("1.2.3", {
          "1.2.3": darwinArm64Release("1.2.3", okouZipUrl("1.2.3")),
        }),
      );
      expect((await appcastRequest()).status).toBe(200);

      countingManifestHandler(() => {
        return new HttpResponse(null, { status: 404 });
      });
      mockNow(initialNow + 5 * 60_000);

      const response = await appRequest(
        "http://api.test/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/appcast.xml",
      );

      expect(response.status).toBe(500);
    });
  });
});
