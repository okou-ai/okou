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
  it("serves the cached release while the manifest host is unreachable", async () => {
    const initialNow = Date.parse("2026-06-08T00:00:00.000Z");

    await withMockNowForTest(initialNow, async () => {
      mockDesktopUpdateManifest(
        stableManifest("1.2.3", {
          "1.2.3": darwinArm64Release("1.2.3", okouZipUrl("1.2.3")),
        }),
      );

      const warmed = await appcastRequest();
      expect(warmed.status).toBe(200);
      await expect(warmed.text()).resolves.toContain(
        "<sparkle:version>1.2.3</sparkle:version>",
      );

      countingManifestHandler(() => {
        return HttpResponse.error();
      });
      mockNow(initialNow + 30 * 60_000 - 1);

      const stale = await appcastRequest();
      expect(stale.status).toBe(200);

      await expect(stale.text()).resolves.toContain(
        "<sparkle:version>1.2.3</sparkle:version>",
      );
    });
  });
});
