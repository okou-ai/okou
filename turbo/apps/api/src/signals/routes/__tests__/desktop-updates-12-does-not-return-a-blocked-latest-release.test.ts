import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";

import { createDesktopUpdatePublicApi } from "./helpers/desktop-update-public";

const context = testContext();
const {
  appcastRequest,
  mockDesktopUpdateManifest,
  stableManifest,
  darwinArm64Release,
  okouZipUrl,
} = createDesktopUpdatePublicApi(context);

// Default Vitest file isolation gives this scenario a fresh module cache.
describe("desktop update routes", () => {
  it("does not return a blocked latest release", async () => {
    const previousUrl = okouZipUrl("0.52.0");
    mockDesktopUpdateManifest(
      stableManifest(
        "0.52.1",
        {
          "0.52.0": darwinArm64Release("0.52.0", previousUrl),
          "0.52.1": darwinArm64Release("0.52.1", okouZipUrl("0.52.1")),
          "0.53.0": darwinArm64Release("0.53.0", okouZipUrl("0.53.0")),
        },
        ["0.52.1"],
      ),
    );

    const response = await appcastRequest();
    expect(response.status).toBe(200);

    const responseXml = await response.text();

    expect(responseXml).toContain("<sparkle:version>0.52.0</sparkle:version>");
    expect(responseXml).toContain(`<enclosure url="${previousUrl}"`);
  });
});
