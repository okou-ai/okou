import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";

import { mockNow, withMockNowForTest } from "../../../lib/time";

import { createDesktopUpdatePublicApi } from "./helpers/desktop-update-public";

const context = testContext();
const {
  mockDesktopUpdateManifest,
  stableManifest,
  darwinArm64Release,
  okouZipUrl,
  appcastRequest,
  countingManifestHandler,
} = createDesktopUpdatePublicApi(context);

// Default Vitest file isolation gives this scenario a fresh module cache.
describe("desktop update routes", () => {
  it("keeps the cached release usable across a failed refresh", async () => {
    const initialNow = Date.parse("2026-06-08T00:00:00.000Z");

    await withMockNowForTest(initialNow, async () => {
      mockDesktopUpdateManifest(
        stableManifest("1.2.3", {
          "1.2.3": darwinArm64Release("1.2.3", okouZipUrl("1.2.3")),
        }),
      );
      await expect(appcastRequest()).resolves.toMatchObject({ status: 200 });

      countingManifestHandler(() => {
        return HttpResponse.error();
      });
      mockNow(initialNow + 5 * 60_000);
      await expect(appcastRequest()).resolves.toMatchObject({ status: 200 });

      // A failed refresh must not evict or age the entry, and a later success
      // must replace it outright rather than merge with it.
      mockDesktopUpdateManifest(
        stableManifest("1.2.4", {
          "1.2.4": darwinArm64Release("1.2.4", okouZipUrl("1.2.4")),
        }),
      );
      mockNow(initialNow + 10 * 60_000);
      const refreshed = await appcastRequest();
      expect(refreshed.status).toBe(200);

      await expect(refreshed.text()).resolves.toContain(
        "<sparkle:version>1.2.4</sparkle:version>",
      );
    });
  });
});
