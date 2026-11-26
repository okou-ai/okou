import { expect, test } from "vitest";

import {
  accept,
  desktopCompatibility,
  testContext,
} from "../../../__tests__/test-context";
import { createDesktopUpdatePublicApi } from "./helpers/desktop-update-public";

const context = testContext();
const desktop = createDesktopUpdatePublicApi(context);
const feed = {
  product: "ai-okou-desktop",
  channel: "stable",
  platform: "darwin",
  arch: "arm64",
} as const;

test("desktop-updates-02-marks-only-supported-sparkle-replacements-critical-and-keeps-the-001 marks the supported release critical while the Electron feed and DMG stay reachable", async () => {
  desktopCompatibility.minimumSupportedVersion = "0.51.0";
  desktop.mockDesktopUpdateManifest(
    desktop.stableManifest("0.51.0", {
      "0.51.0": desktop.darwinArm64Release(
        "0.51.0",
        desktop.okouZipUrl("0.51.0"),
      ),
      "0.50.1": desktop.darwinArm64Release(
        "0.50.1",
        desktop.okouZipUrl("0.50.1"),
      ),
    }),
  );
  const updates = desktop.client();

  const appcast = await desktop.appcastRequest();
  const legacy = await accept(updates.productFeed({ params: feed }), [200]);
  const dmg = await accept(updates.productDmgDownload({ params: feed }), [302]);

  expect(appcast.status).toBe(200);
  const xml = await appcast.text();
  expect(xml).toContain("<sparkle:version>0.51.0</sparkle:version>");
  expect(xml).toContain('<sparkle:criticalUpdate sparkle:version="0.51.0"/>');
  expect(legacy.body.currentRelease).toBe("0.52.2");
  expect(dmg.headers.get("location")).toBe(
    "https://github.com/okou-ai/okou/releases/download/okou-desktop-v0.51.0/Okou-darwin-arm64-0.51.0.dmg",
  );
});
