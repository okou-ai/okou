import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";

import { createDesktopUpdatePublicApi } from "./helpers/desktop-update-public";

const context = testContext();
const {
  stableManifest,
  darwinArm64Release,
  okouZipUrl,
  appcastRequest,
  countingManifestHandler,
} = createDesktopUpdatePublicApi(context);

// Default Vitest file isolation gives this scenario a fresh module cache.
describe("desktop update routes", () => {
  it("bounds each attempt so a hanging upstream cannot hold the request", async () => {
    // A real deadline would make this test wait for it. Firing it immediately
    // proves the same thing that matters: the fetch is bound to a deadline
    // signal, and tripping it is retried and then reported as unavailable
    // rather than surfacing as an unhandled error.
    context.mocks.abortSignal.timeout.mockImplementation(() => {
      const controller = new AbortController();
      controller.abort(
        new DOMException("The operation timed out", "TimeoutError"),
      );
      return controller.signal;
    });
    countingManifestHandler(() => {
      return HttpResponse.json(
        stableManifest("1.2.3", {
          "1.2.3": darwinArm64Release("1.2.3", okouZipUrl("1.2.3")),
        }),
      );
    });

    const response = await appcastRequest();
    expect(response.status).toBe(503);

    await expect(response.json()).resolves.toMatchObject({
      error: { code: "DESKTOP_UPDATE_UNAVAILABLE" },
    });
    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
  });
});
