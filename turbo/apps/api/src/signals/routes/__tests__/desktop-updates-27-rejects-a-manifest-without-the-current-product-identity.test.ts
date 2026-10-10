import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";

import { createDesktopUpdatePublicApi } from "./helpers/desktop-update-public";

const context = testContext();
const {
  appRequest,
  countingManifestHandler,
  mockDesktopUpdateManifest,
  stableManifest,
  darwinArm64Release,
  okouZipUrl,
  appcastRequest,
} = createDesktopUpdatePublicApi(context);

describe("desktop update routes", () => {
  it("rejects unidentified and retired-product manifests and recovers when the publisher corrects them", async () => {
    const url = okouZipUrl("1.2.3");
    const manifest = stableManifest("1.2.3", {
      "1.2.3": darwinArm64Release("1.2.3", url),
    });
    const unidentified = {
      schemaVersion: manifest.schemaVersion,
      channels: manifest.channels,
      releases: manifest.releases,
    };

    for (const invalid of [unidentified, { ...manifest, product: "zero" }]) {
      countingManifestHandler(() => {
        return HttpResponse.json(invalid);
      });
      for (const path of [
        "http://api.test/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/appcast.xml",
        "http://api.test/api/desktop/updates/stable/darwin/arm64/dmg",
      ]) {
        const response = await appRequest(path);
        expect(response.status).toBe(500);
      }
    }

    mockDesktopUpdateManifest(manifest);
    const recovered = await appcastRequest();
    expect(recovered.status).toBe(200);
    const recoveredXml = await recovered.text();
    expect(recoveredXml).toContain("<sparkle:version>1.2.3</sparkle:version>");
    expect(recoveredXml).toContain(`<enclosure url="${url}"`);
  });
});
