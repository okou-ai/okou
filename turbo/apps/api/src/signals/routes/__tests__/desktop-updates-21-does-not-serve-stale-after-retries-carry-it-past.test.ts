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
  it("does not serve stale after retries carry it past the stale deadline", async () => {
    const initialNow = Date.parse("2026-06-08T00:00:00.000Z");

    await withMockNowForTest(initialNow, async () => {
      mockDesktopUpdateManifest(
        stableManifest("1.2.3", {
          "1.2.3": darwinArm64Release("1.2.3", okouZipUrl("1.2.3")),
        }),
      );
      expect((await appcastRequest()).status).toBe(200);

      mockNow(initialNow + 30 * 60_000 - 1);
      countingManifestHandler(() => {
        // The retry began inside the stale window, but completes after it.
        // The service must evaluate stale eligibility when it is about to
        // answer, not when the request started.
        mockNow(initialNow + 30 * 60_000);
        return HttpResponse.error();
      });

      const response = await appcastRequest();
      expect(response.status).toBe(503);

      await expect(response.json()).resolves.toMatchObject({
        error: { code: "DESKTOP_UPDATE_UNAVAILABLE" },
      });
    });
  });
});
