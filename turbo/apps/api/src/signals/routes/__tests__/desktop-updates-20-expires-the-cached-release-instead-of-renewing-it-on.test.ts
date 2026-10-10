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
  it("expires the cached release instead of renewing it on each stale hit", async () => {
    const initialNow = Date.parse("2026-06-08T00:00:00.000Z");

    await withMockNowForTest(initialNow, async () => {
      mockDesktopUpdateManifest(
        stableManifest("1.2.3", {
          "1.2.3": darwinArm64Release("1.2.3", okouZipUrl("1.2.3")),
        }),
      );
      expect((await appcastRequest()).status).toBe(200);

      countingManifestHandler(() => {
        return HttpResponse.error();
      });

      for (const minutes of [10, 20, 29]) {
        mockNow(initialNow + minutes * 60_000);
        const stale = await appcastRequest();
        expect(stale.status).toBe(200);
        expect(await stale.text()).toContain(
          "<sparkle:version>1.2.3</sparkle:version>",
        );
      }

      mockNow(initialNow + 30 * 60_000);
      const expired = await appcastRequest();
      expect(expired.status).toBe(503);

      await expect(expired.json()).resolves.toMatchObject({
        error: { code: "DESKTOP_UPDATE_UNAVAILABLE" },
      });
    });
  });
});
