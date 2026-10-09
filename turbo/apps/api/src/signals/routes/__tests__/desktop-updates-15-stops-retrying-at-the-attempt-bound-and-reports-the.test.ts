import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";

import { createDesktopUpdatePublicApi } from "./helpers/desktop-update-public";

const context = testContext();
const { feedRequest, countingManifestHandler } =
  createDesktopUpdatePublicApi(context);

// Default Vitest file isolation gives this scenario a fresh module cache.
describe("desktop update routes", () => {
  it("stops retrying at the attempt bound and reports the feed as unavailable", async () => {
    const upstream = countingManifestHandler(() => {
      return new HttpResponse(null, { status: 500 });
    });

    const response = await accept(feedRequest(), [503]);

    expect(response.body.error.code).toBe("DESKTOP_UPDATE_UNAVAILABLE");
    expect(upstream.attempts()).toBe(3);
    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
  });
});
