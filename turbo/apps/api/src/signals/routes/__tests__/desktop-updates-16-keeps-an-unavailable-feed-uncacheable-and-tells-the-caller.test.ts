import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";

import { createDesktopUpdatePublicApi } from "./helpers/desktop-update-public";

const context = testContext();
const { appRequest, countingManifestHandler } =
  createDesktopUpdatePublicApi(context);

// Default Vitest file isolation gives this scenario a fresh module cache.
describe("desktop update routes", () => {
  it("keeps an unavailable feed uncacheable and tells the caller to retry", async () => {
    countingManifestHandler(() => {
      return HttpResponse.error();
    });

    const response = await appRequest(
      "http://api.test/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/RELEASES.json",
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Retry-After")).toBe("60");
  });
});
