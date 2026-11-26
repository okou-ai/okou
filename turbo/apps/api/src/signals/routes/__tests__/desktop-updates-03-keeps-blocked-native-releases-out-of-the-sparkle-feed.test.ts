import { expect, test } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { createDesktopUpdatePublicApi } from "./helpers/desktop-update-public";

const context = testContext();
const desktop = createDesktopUpdatePublicApi(context);

test("desktop-updates-03-keeps-blocked-native-releases-out-of-the-sparkle-feed-001 advertises the newest unblocked Native release instead of the blocked target", async () => {
  desktop.mockDesktopUpdateManifest(
    desktop.stableManifest(
      "0.50.1",
      {
        "0.50.0": desktop.darwinArm64Release(
          "0.50.0",
          desktop.okouZipUrl("0.50.0"),
        ),
        "0.50.1": desktop.darwinArm64Release(
          "0.50.1",
          desktop.okouZipUrl("0.50.1"),
        ),
      },
      ["0.50.1"],
    ),
  );

  const appcast = await desktop.appcastRequest();

  expect(appcast.status).toBe(200);
  expect(appcast.headers.get("content-type")).toMatch(/^application\/rss\+xml/);
  expect(appcast.headers.get("cache-control")).toBe("no-store");
  const xml = await appcast.text();
  expect(xml).toContain("<sparkle:version>0.50.0</sparkle:version>");
  expect(xml).toContain(`<enclosure url="${desktop.okouZipUrl("0.50.0")}"`);
  expect(xml).not.toContain("0.50.1");
});
