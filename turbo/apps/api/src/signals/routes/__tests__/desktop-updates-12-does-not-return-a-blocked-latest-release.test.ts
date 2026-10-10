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
    const previousUrl = okouZipUrl("0.2.1");
    mockDesktopUpdateManifest(
      stableManifest(
        "0.2.2",
        {
          "0.2.1": darwinArm64Release("0.2.1", previousUrl),
          "0.2.2": darwinArm64Release("0.2.2", okouZipUrl("0.2.2")),
          "0.3.0": darwinArm64Release("0.3.0", okouZipUrl("0.3.0")),
        },
        ["0.2.2"],
      ),
    );

    const response = await appcastRequest();
    expect(response.status).toBe(200);

    const responseXml = await response.text();

    expect(responseXml).toContain("<sparkle:version>0.2.1</sparkle:version>");
    expect(responseXml).toContain(`<enclosure url="${previousUrl}"`);
  });
});
