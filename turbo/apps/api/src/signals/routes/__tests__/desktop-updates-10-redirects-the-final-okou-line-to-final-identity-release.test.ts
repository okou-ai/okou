import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { createDesktopUpdatePublicApi } from "./helpers/desktop-update-public";

const context = testContext();
const desktop = createDesktopUpdatePublicApi(context);

test("desktop-updates-10-redirects-the-final-okou-line-to-final-identity-release-001 redirects the Okou line's release and DMG routes to the final-identity assets", async () => {
  desktop.mockDesktopUpdateManifest(
    desktop.stableManifest("1.2.3", {
      "1.2.3": desktop.darwinArm64Release("1.2.3", desktop.okouZipUrl("1.2.3")),
    }),
  );
  const updates = desktop.client();
  const params = {
    product: "ai-okou-desktop",
    channel: "stable",
    platform: "darwin",
    arch: "arm64",
  } as const;

  const release = await accept(updates.productReleasePage({ params }), [302]);
  const dmg = await accept(updates.productDmgDownload({ params }), [302]);

  expect(release.headers.get("location")).toBe(
    "https://github.com/okou-ai/okou/releases/tag/okou-desktop-v1.2.3",
  );
  expect(dmg.headers.get("location")).toBe(
    "https://github.com/okou-ai/okou/releases/download/okou-desktop-v1.2.3/Okou-darwin-arm64-1.2.3.dmg",
  );
});
