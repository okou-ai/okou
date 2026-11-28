import { expect, test } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { createDesktopUpdatePublicApi } from "./helpers/desktop-update-public";

const context = testContext();
const desktop = createDesktopUpdatePublicApi(context);
const releaseText = Object.freeze({
  name: "Okou & <native>",
  notes: 'Text "quoted" <script>',
});

test("desktop-updates-04-escapes-release-text-in-the-native-xml-feed-001 escapes the release title and notes in the Sparkle feed", async () => {
  desktop.mockDesktopUpdateManifest(
    desktop.stableManifest("0.50.0", {
      "0.50.0": {
        ...desktop.darwinArm64Release("0.50.0", desktop.okouZipUrl("0.50.0")),
        ...releaseText,
      },
    }),
  );

  const appcast = await desktop.appcastRequest();

  expect(appcast.status).toBe(200);
  const xml = await appcast.text();
  expect(xml).toContain("Okou &amp; &lt;native&gt;");
  expect(xml).toContain("Text &quot;quoted&quot; &lt;script&gt;");
});
