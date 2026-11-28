import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { createDesktopUpdatePublicApi } from "./helpers/desktop-update-public";

const context = testContext();
const desktop = createDesktopUpdatePublicApi(context);

test("desktop-updates-07-serves-the-current-okou-desktop-line-on-the-neutral-001 redirects the neutral release and DMG routes to the current Okou release", async () => {
  desktop.mockDesktopUpdateManifest(
    desktop.stableManifest("1.2.3", {
      "1.2.3": desktop.darwinArm64Release("1.2.3", desktop.okouZipUrl("1.2.3")),
    }),
  );
  desktop.mockDesktopUpdateManifest(
    desktop.stableManifest("0.50.0", {
      "0.50.0": desktop.darwinArm64Release(
        "0.50.0",
        desktop.okouZipUrl("0.50.0"),
      ),
    }),
    desktop.LEGACY_OKOU_DESKTOP_UPDATE_MANIFEST_URL,
  );
  const updates = desktop.client();
  const params = {
    channel: "stable",
    platform: "darwin",
    arch: "arm64",
  } as const;

  const release = await accept(updates.releasePage({ params }), [302]);
  const dmg = await accept(updates.dmgDownload({ params }), [302]);

  for (const response of [release, dmg]) {
    expect(response.status).toBe(302);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  expect(release.headers.get("location")).toBe(
    "https://github.com/okou-ai/okou/releases/tag/okou-desktop-v1.2.3",
  );
  expect(dmg.headers.get("location")).toBe(
    "https://github.com/okou-ai/okou/releases/download/okou-desktop-v1.2.3/Okou-darwin-arm64-1.2.3.dmg",
  );
});
