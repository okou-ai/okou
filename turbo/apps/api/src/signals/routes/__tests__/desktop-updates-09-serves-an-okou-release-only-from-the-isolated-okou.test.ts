import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";

import { createDesktopUpdatePublicApi } from "./helpers/desktop-update-public";

const context = testContext();
const {
  client,
  mockDesktopUpdateManifest,
  stableManifest,
  darwinArm64Release,
  okouZipUrl,
} = createDesktopUpdatePublicApi(context);

// Default Vitest file isolation gives this scenario a fresh module cache.
describe("desktop update routes", () => {
  it("serves an Okou release only from the isolated Okou manifest", async () => {
    const zipUrl = okouZipUrl("1.2.3");
    mockDesktopUpdateManifest(
      stableManifest("1.2.3", {
        "1.2.3": darwinArm64Release("1.2.3", zipUrl),
      }),
    );

    const response = await accept(
      client().productFeed({
        params: {
          product: "ai-okou-desktop",
          channel: "stable",
          platform: "darwin",
          arch: "arm64",
        },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      currentRelease: "1.2.3",
      releases: [
        {
          version: "1.2.3",
          updateTo: {
            name: "Okou 1.2.3",
            version: "1.2.3",
            pub_date: "2026-06-08T00:00:00.000Z",
            url: zipUrl,
            notes: "Release 1.2.3",
          },
        },
      ],
    });
  });
});
