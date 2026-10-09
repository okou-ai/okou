import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";

import { createDesktopUpdatePublicApi } from "./helpers/desktop-update-public";

const context = testContext();
const {
  appRequest,
  mockDesktopUpdateManifest,
  stableManifest,
  darwinArm64Release,
  okouZipUrl,
} = createDesktopUpdatePublicApi(context);

// Default Vitest file isolation gives this scenario a fresh module cache.
describe("desktop update routes", () => {
  it("escapes release text in the native XML feed", async () => {
    const release = darwinArm64Release("0.50.0", okouZipUrl("0.50.0"));
    release.name = "Okou & <native>";
    release.notes = 'Text "quoted" <script>';
    mockDesktopUpdateManifest(
      stableManifest("0.50.0", {
        "0.50.0": release,
      }),
    );
    const response = await appRequest(
      "/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/appcast.xml",
    );
    expect(response.status).toBe(200);
    const xml = await response.text();
    expect(xml).toContain("Okou &amp; &lt;native&gt;");
    expect(xml).toContain("Text &quot;quoted&quot; &lt;script&gt;");
  });
});
