import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { createDesktopUpdatePublicApi } from "./helpers/desktop-update-public";

const context = testContext();
const { client, appRequest, countingManifestHandler, okouZipUrl } =
  createDesktopUpdatePublicApi(context);

describe("desktop update routes", () => {
  it("serves the fixed migration hop independently of missing, broken or unavailable Native metadata", async () => {
    for (const [upstream, status] of [
      [new HttpResponse(null, { status: 404 }), 500],
      [HttpResponse.json({ schemaVersion: 1 }), 500],
      [new HttpResponse(null, { status: 503 }), 503],
    ] as const) {
      countingManifestHandler(() => {
        return upstream.clone();
      });
      const native = await appRequest(
        "/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/appcast.xml",
      );
      expect(native.status).toBe(status);
      const legacy = await accept(
        client().productFeed({
          params: {
            product: "ai-okou-desktop",
            channel: "stable",
            platform: "darwin",
            arch: "arm64",
          },
        }),
        [200],
      );
      expect(legacy.body.currentRelease).toBe("0.52.2");
      expect(legacy.body.releases[0]?.updateTo.url).toBe(okouZipUrl("0.52.2"));
    }
  });
});
