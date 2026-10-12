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
  it("serves an Okou release only from the isolated Okou manifest", async () => {
    const zipUrl = okouZipUrl("1.2.3");
    mockDesktopUpdateManifest(
      stableManifest("1.2.3", {
        "1.2.3": darwinArm64Release("1.2.3", zipUrl),
      }),
    );

    const response = await appcastRequest();
    expect(response.status).toBe(200);

    const responseXml = await response.text();

    expect(responseXml).toContain("<sparkle:version>1.2.3</sparkle:version>");
    expect(responseXml).toContain("<title>Okou 1.2.3</title>");
    expect(responseXml).toContain(
      "<pubDate>Mon, 08 Jun 2026 00:00:00 GMT</pubDate>",
    );
    expect(responseXml).toContain("<description>Release 1.2.3</description>");
    expect(responseXml).toContain(`<enclosure url="${zipUrl}"`);
  });
});
