import { expect, test } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { createDesktopUpdatePublicApi } from "./helpers/desktop-update-public";

const context = testContext();
const desktop = createDesktopUpdatePublicApi(context);

test("desktop-updates-09-serves-an-okou-release-only-from-the-isolated-okou-001 serves the R2 manifest release in the Sparkle feed", async () => {
  desktop.mockDesktopUpdateManifest(
    desktop.stableManifest("1.2.3", {
      "1.2.3": desktop.darwinArm64Release("1.2.3", desktop.okouZipUrl("1.2.3")),
    }),
  );

  const appcast = await desktop.appcastRequest();

  expect(appcast.status).toBe(200);
  const xml = await appcast.text();
  expect(xml).toContain("<sparkle:version>1.2.3</sparkle:version>");
  expect(xml).toContain("<title>Okou 1.2.3</title>");
  expect(xml).toContain("<pubDate>Mon, 08 Jun 2026 00:00:00 GMT</pubDate>");
  expect(xml).toContain("<description>Release 1.2.3</description>");
  expect(xml).toContain(`<enclosure url="${desktop.okouZipUrl("1.2.3")}"`);
});
