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
  it("keeps blocked Native releases out of the Sparkle feed", async () => {
    mockDesktopUpdateManifest(
      stableManifest(
        "0.50.1",
        {
          "0.50.0": darwinArm64Release("0.50.0", okouZipUrl("0.50.0")),
          "0.50.1": darwinArm64Release("0.50.1", okouZipUrl("0.50.1")),
        },
        ["0.50.1"],
      ),
    );
    const path = "/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/";
    const native = await appRequest(`${path}appcast.xml`);
    expect(native.status).toBe(200);
    expect(native.headers.get("content-type")).toContain("application/rss+xml");
    expect(native.headers.get("cache-control")).toBe("no-store");
    const xml = await native.text();
    expect(xml).toContain('<enclosure url="' + okouZipUrl("0.50.0") + '"');
    expect(xml).toContain("<sparkle:version>0.50.0</sparkle:version>");
    expect(xml).not.toContain("0.50.1");
  });
});
