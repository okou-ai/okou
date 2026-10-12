import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";

import { createDesktopUpdatePublicApi } from "./helpers/desktop-update-public";

const context = testContext();
const { appRequest, appcastRequest, countingManifestHandler } =
  createDesktopUpdatePublicApi(context);

// Default Vitest file isolation gives this scenario a fresh module cache.
describe("desktop update routes", () => {
  it("reports every manifest-backed route as unavailable, including the wall's download", async () => {
    countingManifestHandler(() => {
      return HttpResponse.error();
    });

    const feedResponse = await appcastRequest();
    expect(feedResponse.status).toBe(503);
    await expect(feedResponse.json()).resolves.toMatchObject({
      error: { code: "DESKTOP_UPDATE_UNAVAILABLE" },
    });

    // The redirect routes read the same manifest, so they share the status.
    // The Platform download button uses this neutral DMG route.
    const dmgResponse = await appRequest(
      "http://api.test/api/desktop/updates/stable/darwin/arm64/dmg",
    );
    expect(dmgResponse.status).toBe(503);

    const releaseResponse = await appRequest(
      "http://api.test/api/desktop/updates/stable/darwin/arm64/release",
    );
    expect(releaseResponse.status).toBe(503);

    const productDmgResponse = await appRequest(
      "http://api.test/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/dmg",
    );
    expect(productDmgResponse.status).toBe(503);

    const productReleaseResponse = await appRequest(
      "http://api.test/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/release",
    );
    expect(productReleaseResponse.status).toBe(503);
  });
});
