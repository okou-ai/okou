import { expect, test } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { createDesktopUpdatePublicApi } from "./helpers/desktop-update-public";

const context = testContext();
const desktop = createDesktopUpdatePublicApi(context);

test("desktop-updates-12-does-not-return-a-blocked-latest-release-001 falls back to the newest eligible release below the blocked target", async () => {
  desktop.mockDesktopUpdateManifest(
    desktop.stableManifest(
      "0.52.1",
      {
        "0.52.0": desktop.darwinArm64Release(
          "0.52.0",
          desktop.okouZipUrl("0.52.0"),
        ),
        "0.52.1": desktop.darwinArm64Release(
          "0.52.1",
          desktop.okouZipUrl("0.52.1"),
        ),
        "0.53.0": desktop.darwinArm64Release(
          "0.53.0",
          desktop.okouZipUrl("0.53.0"),
        ),
      },
      ["0.52.1"],
    ),
  );

  const appcast = await desktop.appcastRequest();

  expect(appcast.status).toBe(200);
  const xml = await appcast.text();
  expect(xml).toContain("<sparkle:version>0.52.0</sparkle:version>");
  expect(xml).toContain(`<enclosure url="${desktop.okouZipUrl("0.52.0")}"`);
});
