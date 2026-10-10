import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";

import { createDesktopUpdatePublicApi } from "./helpers/desktop-update-public";

const context = testContext();
const { appcastRequest, mockDesktopUpdateManifest, stableManifest } =
  createDesktopUpdatePublicApi(context);

// Default Vitest file isolation gives this scenario a fresh module cache.
describe("desktop update routes", () => {
  it("returns not found when the manifest has no matching asset", async () => {
    mockDesktopUpdateManifest(
      stableManifest("0.2.1", {
        "0.2.1": {
          version: "0.2.1",
          pubDate: "2026-06-08T00:00:00.000Z",
          platforms: {
            darwin: {},
          },
        },
      }),
    );

    const response = await appcastRequest();
    expect(response.status).toBe(404);

    await expect(response.json()).resolves.toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });
});
