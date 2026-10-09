import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";

import { createDesktopUpdatePublicApi } from "./helpers/desktop-update-public";

const context = testContext();
const { appRequest, countingManifestHandler } =
  createDesktopUpdatePublicApi(context);

// Default Vitest file isolation gives this scenario a fresh module cache.
describe("desktop update routes", () => {
  it("fails loudly when the manifest body is not json", async () => {
    const upstream = countingManifestHandler(() => {
      return new HttpResponse("not-a-manifest", {
        headers: { "content-type": "application/json" },
      });
    });

    const response = await appRequest(
      "http://api.test/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/RELEASES.json",
    );

    expect(response.status).toBe(500);
    expect(upstream.attempts()).toBe(1);
    expect(context.mocks.sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ name: "SyntaxError" }),
    );
  });
});
