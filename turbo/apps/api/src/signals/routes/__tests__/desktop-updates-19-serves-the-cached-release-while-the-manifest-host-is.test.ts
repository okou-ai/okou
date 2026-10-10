import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";

import { mockNow, withMockNowForTest } from "../../../lib/time";

import { createDesktopUpdatePublicApi } from "./helpers/desktop-update-public";

const context = testContext();
const {
  mockDesktopUpdateManifest,
  stableManifest,
  darwinArm64Release,
  okouZipUrl,
  feedRequest,
  countingManifestHandler,
} = createDesktopUpdatePublicApi(context);

// Default Vitest file isolation gives this scenario a fresh module cache.
describe("desktop update routes", () => {
  it("serves the cached release while the manifest host is unreachable", async () => {
    const initialNow = Date.parse("2026-06-08T00:00:00.000Z");

    await withMockNowForTest(initialNow, async () => {
      mockDesktopUpdateManifest(
        stableManifest("1.2.3", {
          "1.2.3": darwinArm64Release("1.2.3", okouZipUrl("1.2.3")),
        }),
      );

      const warmed = await accept(feedRequest(), [200]);
      expect(warmed.body.currentRelease).toBe("1.2.3");

      countingManifestHandler(() => {
        return HttpResponse.error();
      });
      mockNow(initialNow + 30 * 60_000 - 1);

      const stale = await accept(feedRequest(), [200]);

      expect(stale.body.currentRelease).toBe("1.2.3");
    });
  });
});
