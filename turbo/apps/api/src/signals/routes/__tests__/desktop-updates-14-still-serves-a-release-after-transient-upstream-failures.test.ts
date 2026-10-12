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
  it("still serves a release after transient upstream failures", async () => {
    const upstream = countingManifestHandler((attempt) => {
      if (attempt < 3) {
        return new HttpResponse(null, { status: 502 });
      }
      return HttpResponse.json(
        stableManifest("1.2.3", {
          "1.2.3": darwinArm64Release("1.2.3", okouZipUrl("1.2.3")),
        }),
      );
    });

    const response = await appcastRequest();
    expect(response.status).toBe(200);

    await expect(response.text()).resolves.toContain(
      "<sparkle:version>1.2.3</sparkle:version>",
    );
    expect(upstream.attempts()).toBe(3);
    // Absorbed, so it must not reach the error channel that pages a human.
    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
  });
});
