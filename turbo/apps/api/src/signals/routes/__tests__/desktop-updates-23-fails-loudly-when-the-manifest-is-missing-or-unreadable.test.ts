import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";

import { createDesktopUpdatePublicApi } from "./helpers/desktop-update-public";

const context = testContext();
const { appRequest, countingManifestHandler } =
  createDesktopUpdatePublicApi(context);

// Default Vitest file isolation gives this scenario a fresh module cache.
describe("desktop update routes", () => {
  it("fails loudly when the manifest is missing or unreadable", async () => {
    const missing = countingManifestHandler(() => {
      return new HttpResponse(null, { status: 404 });
    });

    const missingResponse = await appRequest(
      "http://api.test/api/desktop/updates/stable/darwin/arm64/dmg",
    );

    expect(missingResponse.status).toBe(500);
    // A manifest our own release pipeline publishes is not an outage, so it
    // is neither retried nor downgraded.
    expect(missing.attempts()).toBe(1);
    expect(context.mocks.sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Desktop update manifest fetch failed with 404",
      }),
    );

    countingManifestHandler(() => {
      return HttpResponse.json({ schemaVersion: 1 });
    });

    const invalidResponse = await appRequest(
      "http://api.test/api/desktop/updates/stable/darwin/arm64/dmg",
    );
    expect(invalidResponse.status).toBe(500);
  });
});
